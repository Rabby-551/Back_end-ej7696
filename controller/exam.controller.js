import httpStatus from "http-status";
import mongoose from "mongoose";
import AppError from "../errors/AppError.js";
import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";
import { uploadOnCloudinary } from "../utils/commonMethod.js";
import { Exam } from "../model/exam.model.js";
import { ExamQuestionCache } from "../model/examQuestionCache.model.js";
import { ExamAttempt } from "../model/examAttempt.model.js";
import { QuestionUsage } from "../model/questionUsage.model.js";
import { ExamAccess } from "../model/examAccess.model.js";
import { AppSetting } from "../model/appSetting.model.js";
import { ExamRating } from "../model/examRating.model.js";
import { User } from "../model/user.model.js";
import {
  canAccessOwnedExam,
  isExamEntitlementActive,
  isExamOwned,
} from "../utils/examAccess.helpers.js";
import { expireExamEntitlements } from "../utils/examSubscription.service.js";
import {
  approveQuestionBankReviewBatches,
  QUESTION_BANK_DEFAULT_BATCH_SIZE,
  QUESTION_BANK_DEFAULT_TARGET,
  buildExamContentHash,
  ensureQuestionBankCapacity,
  generateQuestionBankInBatches,
  getQuestionBankStatus,
  listQuestionBankReviewQuestions,
  listQuestionBankQuestions,
  selectQuestionsFromBank,
} from "../utils/questionBank.service.js";

const QUESTION_SERVICE_DEFAULT_EXAM_TYPE =
  process.env.QUESTION_SERVICE_DEFAULT_EXAM_TYPE?.toString().trim() ||
  "closed_book";
const SUBSCRIPTION_QUESTION_LIMIT_PER_EXAM = 1200;
const QUESTION_BANK_MIN_BATCH_SIZE = 1;
const QUESTION_BANK_MAX_BATCH_SIZE = Math.max(
  Number(process.env.QUESTION_BANK_MAX_BATCH_SIZE) || 1000,
  QUESTION_BANK_MIN_BATCH_SIZE
);

const parseStatus = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = value.toString().toLowerCase();
  if (!["active", "inactive"].includes(normalized)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Status must be active or inactive");
  }
  return normalized;
};

const parseReviewStatus = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  let normalized = value.toString().toLowerCase();
  if (normalized === "publish") normalized = "published";
  if (!["pending", "published"].includes(normalized)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Review status must be pending or published"
    );
  }
  return normalized;
};

const sanitizeExam = (doc) => {
  if (!doc) return doc;
  return doc.toObject ? doc.toObject() : doc;
};

const parseQuestionCount = (value) => {
  const resolved = value ?? 1;
  const parsed = Number(resolved);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "n_question must be a positive number"
    );
  }
  return Math.ceil(parsed);
};

const parseDurationMinutes = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "durationMinutes must be a positive number"
    );
  }
  return Math.ceil(parsed);
};

const parsePositiveInteger = (value, fallback, fieldName) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `${fieldName} must be a positive number`
    );
  }
  return Math.ceil(parsed);
};

const parseQuestionBankBatchSize = (value, fallback = QUESTION_BANK_DEFAULT_BATCH_SIZE) => {
  const parsed = parsePositiveInteger(value, fallback, "batchSize");
  return Math.max(
    QUESTION_BANK_MIN_BATCH_SIZE,
    Math.min(QUESTION_BANK_MAX_BATCH_SIZE, parsed)
  );
};

const calculateTotalBatches = (targetCount, batchSize) => {
  const safeTarget = Math.max(Number(targetCount) || 1, 1);
  const safeBatchSize = Math.max(Number(batchSize) || 1, 1);
  return Math.max(Math.ceil(safeTarget / safeBatchSize), 1);
};

const parseBoolean = (value) => {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  const normalized = value.toString().toLowerCase();
  return ["true", "1", "yes", "y", "on"].includes(normalized);
};

const dateValuesEqual = (left, right) => {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return new Date(left).getTime() === new Date(right).getTime();
};

const defaultProgress = () => ({
  answers: [],
  timeSpentSec: [],
  currentIndex: 0,
  flaggedQuestionIds: [],
  lastSavedAt: null,
});

const buildQuestionUsage = ({
  isSubscriptionLimited = false,
  questionsGenerated = 0,
  questionLimit = SUBSCRIPTION_QUESTION_LIMIT_PER_EXAM,
  subscriptionStartedAt = null,
  subscriptionExpiresAt = null,
} = {}) => {
  if (!isSubscriptionLimited) {
    return {
      mode: "standard",
      questionLimit: null,
      questionsGenerated: null,
      questionsRemaining: null,
      limitReached: false,
      subscriptionStartedAt: subscriptionStartedAt || null,
      subscriptionExpiresAt: subscriptionExpiresAt || null,
    };
  }

  const used = toNumberOrZero(questionsGenerated);
  const safeLimit = Math.max(toNumberOrZero(questionLimit), 1);
  const remaining = Math.max(safeLimit - used, 0);

  return {
    mode: "subscription",
    questionLimit: safeLimit,
    questionsGenerated: used,
    questionsRemaining: remaining,
    limitReached: remaining === 0,
    subscriptionStartedAt: subscriptionStartedAt || null,
    subscriptionExpiresAt: subscriptionExpiresAt || null,
  };
};

const normalizeAnswerValue = (value) => {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.map((v) => v?.toString().trim().toLowerCase()).filter(Boolean);
  }
  return [value.toString().trim().toLowerCase()].filter(Boolean);
};

const extractVoiceAnalytics = (body = {}) => {
  if (body.voiceAnalytics && typeof body.voiceAnalytics === "object") {
    return body.voiceAnalytics;
  }
  const reviewData = body.reviewData;
  if (!reviewData || typeof reviewData !== "object") return null;
  if (reviewData.voiceAnalytics && typeof reviewData.voiceAnalytics === "object") {
    return reviewData.voiceAnalytics;
  }
  return reviewData.voicePracticeMode || reviewData.voiceModeUsage
    ? reviewData
    : null;
};

const mergeIndexedArray = (existing, updates) => {
  const base = Array.isArray(existing) ? [...existing] : [];
  if (!Array.isArray(updates)) return base;
  updates.forEach((value, index) => {
    if (value !== undefined) {
      base[index] = value;
    }
  });
  return base;
};

const uniqueStrings = (values = []) =>
  [...new Set((Array.isArray(values) ? values : []).map((value) => value?.toString()).filter(Boolean))];

const toNumberOrZero = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const extractQuestionId = (q, index) =>
  q?._id?.toString() ||
  q?.id?.toString() ||
  q?.questionId?.toString() ||
  `q_${index}`;

const normalizeQuestionText = (value) =>
  (value ?? "").toString().replace(/\s+/g, " ").trim().toLowerCase();

const hasDuplicateQuestionText = (questions) => {
  if (!Array.isArray(questions)) return false;
  const seen = new Set();
  for (const question of questions) {
    const normalized = normalizeQuestionText(
      question?.question || question?.text || question?.prompt
    );
    if (!normalized) continue;
    if (seen.has(normalized)) return true;
    seen.add(normalized);
  }
  return false;
};

const getMonthKey = (date = new Date()) => {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  return `${year}-${month}`;
};

const applyQuestionIndex = (questions) => {
  if (!Array.isArray(questions)) return questions;
  return questions.map((q, index) => {
    if (q && typeof q === "object" && !Array.isArray(q)) {
      return { ...q, index };
    }
    return q;
  });
};

const shuffleArray = (items) => {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex],
      shuffled[index],
    ];
  }
  return shuffled;
};

const shuffleQuestionOptions = (question) => {
  if (
    !question ||
    typeof question !== "object" ||
    Array.isArray(question) ||
    !Array.isArray(question.options) ||
    question.options.length < 2
  ) {
    return question;
  }

  return {
    ...question,
    options: shuffleArray(question.options),
  };
};

const prepareQuestionsForDelivery = (questions) => {
  if (!Array.isArray(questions)) return questions;
  return applyQuestionIndex(questions).map(shuffleQuestionOptions);
};

const listExams = async (filter = {}, pageQuery, limitQuery) => {
  const page = Math.max(parseInt(pageQuery, 10) || 1, 1);
  const limit = Math.max(parseInt(limitQuery, 10) || 10, 1);
  const skip = (page - 1) * limit;

  const [exams, total] = await Promise.all([
    Exam.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Exam.countDocuments(filter),
  ]);

  const totalPages = Math.ceil(total / limit) || 1;

  return {
    exams: exams.map(sanitizeExam),
    meta: { page, limit, total, totalPages },
  };
};

const listExamReviews = async (filter = {}, pageQuery, limitQuery) => {
  const page = Math.max(parseInt(pageQuery, 10) || 1, 1);
  const limit = Math.max(parseInt(limitQuery, 10) || 10, 1);
  const skip = (page - 1) * limit;

  const [reviews, total] = await Promise.all([
    ExamRating.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ExamRating.countDocuments(filter),
  ]);

  const totalPages = Math.ceil(total / limit) || 1;

  return {
    reviews,
    meta: { page, limit, total, totalPages },
  };
};

export const createExam = catchAsync(async (req, res) => {
  const { name, effectivitySheetContent, bodyOfKnowledgeContent } = req.body;
  const status = parseStatus(req.body.status);

  if (!name) {
    throw new AppError(httpStatus.BAD_REQUEST, "Exam name is required");
  }

  let image = { public_id: "", url: "" };
  if (req.file) {
    const upload = await uploadOnCloudinary(req.file.buffer);
    image = { public_id: upload.public_id, url: upload.secure_url };
  }

  const nQuestion = parseQuestionCount(
    req.body?.n_question ?? req.body?.nQuestion ?? 1
  );
  const durationMinutes = parseDurationMinutes(
    req.body?.durationMinutes ?? req.body?.duration ?? null
  );

  const exam = await Exam.create({
    name,
    effectivitySheetContent,
    bodyOfKnowledgeContent,
    status: status || "active",
    image,
    createdBy: req.user?._id || null,
    n_question: nQuestion,
    durationMinutes,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Exam created successfully",
    data: sanitizeExam(exam),
  });
});

export const getActiveExams = catchAsync(async (req, res) => {
  const settings = await AppSetting.findOne().lean();
  const unlockPrice = settings?.examUnlockPrice ?? 150;
  const currency = settings?.currency ?? "USD";

  const data = await listExams(
    { status: "active" },
    req.query.page,
    req.query.limit
  );

  if (req.user?._id) {
    const userId = req.user._id.toString();
    const now = new Date();
    await expireExamEntitlements({ userId, now });
    const examIds = data.exams.map((exam) => exam._id);

    const accesses = await ExamAccess.find({
      userId,
      examId: { $in: examIds },
    }).lean();

    const accessMap = accesses.reduce((acc, access) => {
      acc[access.examId.toString()] = access;
      return acc;
    }, {});


    data.exams = data.exams.map((exam) => {
      const access = accessMap[exam._id.toString()];
      const owned = isExamOwned(access);
      const isUnlocked = canAccessOwnedExam({ access, referenceDate: now });
      const expiresAt = access?.expiresAt || null;
      const isExpired = Boolean(
        expiresAt && new Date(expiresAt).getTime() <= now.getTime()
      );
      return {
        ...exam,
        unlockPrice,
        currency,
        unlocked: Boolean(isUnlocked),
        owned,
        requiresSubscription: false,
        accessStatus: isUnlocked ? "unlocked" : "locked",
        entitlementStatus: isUnlocked ? "active" : isExpired ? "expired" : "locked",
        startedAt: access?.startedAt || access?.purchasedAt || null,
        expiresAt,
        isExpired,
        canPurchase: !isUnlocked,
        durationMonths: 6,
        currentPrice: unlockPrice,
        ownershipStatus: access?.status || "free",
        purchaseType: access?.purchaseType || null,
        paymentStatus: access?.paymentStatus || null,
      };
    });
  } else {
    data.exams = data.exams.map((exam) => ({
      ...exam,
      unlockPrice,
      currency,
      unlocked: false,
      owned: false,
      requiresSubscription: false,
      accessStatus: "locked",
      entitlementStatus: "locked",
      startedAt: null,
      expiresAt: null,
      isExpired: false,
      canPurchase: true,
      durationMonths: 6,
      currentPrice: unlockPrice,
      ownershipStatus: "free",
      purchaseType: null,
      paymentStatus: null,
    }));
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Active exams fetched",
    data,
  });
});

export const getAllExamsAdmin = catchAsync(async (req, res) => {
  const statusFilter = parseStatus(req.query.status);
  const filter = {};
  if (statusFilter) filter.status = statusFilter;

  const data = await listExams(filter, req.query.page, req.query.limit);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "All exams fetched",
    data,
  });
});

export const startExam = catchAsync(async (req, res) => {
  const userId = req.user?._id?.toString();
  const examId = req.params.id || req.body.examId;
  const rawExamType =
    req.body?.exam_type ??
    req.query?.exam_type ??
    req.body?.examType ??
    "closed_book";
  const normalizedExamType =
    rawExamType !== undefined && rawExamType !== null
      ? rawExamType.toString().trim()
      : "";
  const exam_type =
    normalizedExamType && normalizedExamType.toLowerCase() !== "standard"
      ? normalizedExamType
      : QUESTION_SERVICE_DEFAULT_EXAM_TYPE;
  // if (!exam_type) {
  //   throw new AppError(
  //     httpStatus.BAD_REQUEST,
  //     "exam_type is required. Provide exam_type or set QUESTION_SERVICE_DEFAULT_EXAM_TYPE."
  //   );
  // }

  if (!userId) {
    throw new AppError(httpStatus.UNAUTHORIZED, "User not authenticated");
  }
  if (!examId) {
    throw new AppError(httpStatus.BAD_REQUEST, "Exam ID is required");
  }

  const exam = await Exam.findById(examId).lean();
  if (!exam) {
    throw new AppError(httpStatus.NOT_FOUND, "Exam not found");
  }
  if (exam.status !== "active") {
    throw new AppError(httpStatus.BAD_REQUEST, "Exam is not active");
  }

  const nQuestion = parseQuestionCount(
    req.body?.n_question ??
      req.body?.nQuestion ??
      req.query?.n_question ??
      exam.n_question ??
      1
  );

  const now = new Date();
  await expireExamEntitlements({ userId, now });
  const monthKey = getMonthKey(now);
  const accessDoc = await ExamAccess.findOne({ userId, examId });
  const isProfessionalUser = isExamEntitlementActive(accessDoc, now);
  const ownsExam = isExamOwned(accessDoc);
  const isUnlocked = ownsExam && isProfessionalUser;
  const subscriptionStartedAt =
    isProfessionalUser && (accessDoc?.startedAt || accessDoc?.purchasedAt)
      ? new Date(accessDoc.startedAt || accessDoc.purchasedAt)
      : null;
  const subscriptionExpiresAt =
    isProfessionalUser && accessDoc?.expiresAt
      ? new Date(accessDoc.expiresAt)
      : null;
  const isStarterUser = !isProfessionalUser;

  if (isStarterUser && !isUnlocked) {
    const hasSubmittedAttempt = await ExamAttempt.exists({
      userId,
      examId,
      status: "SUBMITTED",
    });
    if (hasSubmittedAttempt) {
      throw new AppError(
        httpStatus.FORBIDDEN,
        "Starter users can submit this exam only once. Please subscribe to continue."
      );
    }
  }

  const maxQuestionsPerSession = isUnlocked ? 30 : 2;
  let effectiveQuestionCount = Math.min(nQuestion, maxQuestionsPerSession);

  const durationMinutes =
    parseDurationMinutes(
      req.body?.durationMinutes ??
        req.body?.duration ??
        req.query?.durationMinutes ??
        req.query?.duration ??
        null
    ) ?? exam.durationMinutes ?? null;

  const recreate = parseBoolean(
    req.body?.recreate ??
      req.query?.recreate ??
      req.body?.regenerate ??
      req.query?.regenerate ??
      false
  );

  const existingCache = await ExamQuestionCache.findOne({
    userId,
    examId,
  });

  const isSubscriptionLimited =
    isUnlocked &&
    isProfessionalUser &&
    Boolean(subscriptionStartedAt && subscriptionExpiresAt);
  const existingSubscriptionUsage = existingCache?.subscriptionUsage || {};
  const cacheUsageForActiveSubscription =
    isSubscriptionLimited &&
    dateValuesEqual(existingSubscriptionUsage.cycleStart, subscriptionStartedAt) &&
    dateValuesEqual(existingSubscriptionUsage.cycleEnd, subscriptionExpiresAt);
  const questionsGeneratedForWindow = cacheUsageForActiveSubscription
    ? toNumberOrZero(existingSubscriptionUsage.questionsGenerated)
    : 0;
  const currentQuestionUsage = buildQuestionUsage({
    isSubscriptionLimited,
    questionsGenerated: questionsGeneratedForWindow,
    subscriptionStartedAt,
    subscriptionExpiresAt,
  });
  const questionBankContentHash = buildExamContentHash(exam);
  const cacheMatchesCurrentBank =
    existingCache?.questionBankContentHash === questionBankContentHash;

  if (isSubscriptionLimited) {
    const remainingQuestionsForWindow = Math.max(
      SUBSCRIPTION_QUESTION_LIMIT_PER_EXAM - questionsGeneratedForWindow,
      0
    );
    if (
      remainingQuestionsForWindow > 0 &&
      effectiveQuestionCount > remainingQuestionsForWindow
    ) {
      effectiveQuestionCount = remainingQuestionsForWindow;
    }
  }

  if (!isUnlocked) {
    const perExamAgg = await QuestionUsage.aggregate([
      {
        $match: {
          userId: new mongoose.Types.ObjectId(userId),
          examId: new mongoose.Types.ObjectId(examId),
        },
      },
      { $group: { _id: null, total: { $sum: "$questionsUsed" } } },
    ]);
    const totalUsedForExam = perExamAgg?.[0]?.total || 0;
    if (totalUsedForExam >= 2) {
      throw new AppError(
        httpStatus.FORBIDDEN,
        "Free question limit reached for this exam. Please purchase to unlock more."
      );
    }
    if (totalUsedForExam + effectiveQuestionCount > 2) {
      throw new AppError(
        httpStatus.FORBIDDEN,
        "You can only generate 2 free questions for this exam. Reduce count or purchase this exam."
      );
    }

    const usageAgg = await QuestionUsage.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId), monthKey } },
      { $group: { _id: null, total: { $sum: "$questionsUsed" } } },
    ]);
    const totalUsedThisMonth = usageAgg?.[0]?.total || 0;
    if (totalUsedThisMonth >= 100) {
      throw new AppError(
        httpStatus.FORBIDDEN,
        "Monthly free question limit reached. Please purchase to unlock more."
      );
    }
    if (totalUsedThisMonth + effectiveQuestionCount > 14) {
      throw new AppError(
        httpStatus.FORBIDDEN,
        "Requested questions exceed monthly free limit. Reduce count or purchase this exam."
      );
    }
  }

  let nextSubscriptionUsage = existingCache?.subscriptionUsage || {
    cycleStart: null,
    cycleEnd: null,
    questionsGenerated: 0,
    lastGeneratedAt: null,
  };
  let nextQuestionUsage = currentQuestionUsage;

  if (isSubscriptionLimited) {
    const projectedGeneratedCount =
      questionsGeneratedForWindow + effectiveQuestionCount;

    if (projectedGeneratedCount > SUBSCRIPTION_QUESTION_LIMIT_PER_EXAM) {
      if (
        existingCache &&
        cacheMatchesCurrentBank &&
        Array.isArray(existingCache.questions) &&
        existingCache.questions.length > 0
      ) {
        return sendResponse(res, {
          statusCode: httpStatus.OK,
          success: true,
          message:
            "Subscription question limit reached. Returning previously cached questions.",
          data: {
            fromCache: true,
            status: existingCache.status,
            statusCode: existingCache.statusCode,
            questions: prepareQuestionsForDelivery(existingCache.questions),
            startTime: existingCache.startTime,
            endTime: existingCache.endTime,
            durationMinutes: existingCache.durationMinutes,
            cachedAt: existingCache.updatedAt,
            progress: existingCache.progress || defaultProgress(),
            questionUsage: currentQuestionUsage,
          },
        });
      }

      throw new AppError(
        httpStatus.FORBIDDEN,
        "Subscription question limit reached. Please purchase again to continue."
      );
    }

    nextSubscriptionUsage = {
      cycleStart: subscriptionStartedAt,
      cycleEnd: subscriptionExpiresAt,
      questionsGenerated: projectedGeneratedCount,
      lastGeneratedAt: now,
    };
    nextQuestionUsage = buildQuestionUsage({
      isSubscriptionLimited: true,
      questionsGenerated: projectedGeneratedCount,
      subscriptionStartedAt,
      subscriptionExpiresAt,
    });
  }

  if (
    existingCache &&
    !recreate &&
    cacheMatchesCurrentBank &&
    existingCache.n_question === effectiveQuestionCount &&
    !hasDuplicateQuestionText(existingCache.questions)
  ) {
    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Exam questions fetched from cache",
      data: {
        fromCache: true,
        status: existingCache.status,
        statusCode: existingCache.statusCode,
        questions: prepareQuestionsForDelivery(existingCache.questions),
        startTime: existingCache.startTime,
        endTime: existingCache.endTime,
        durationMinutes: existingCache.durationMinutes,
        cachedAt: existingCache.updatedAt,
        progress: existingCache.progress || defaultProgress(),
        questionUsage: currentQuestionUsage,
      },
    });
  }

  const excludeQuestionHashes =
    recreate && cacheMatchesCurrentBank
      ? uniqueStrings([
          ...(existingCache?.servedQuestionHashes || []),
          ...(existingCache?.questionHashes || []),
        ])
      : [];

  await ensureQuestionBankCapacity({
    exam,
    contentHash: questionBankContentHash,
    requiredCount: effectiveQuestionCount,
    excludeHashes: excludeQuestionHashes,
    initiatedBy: req.user?._id || null,
    trigger: recreate ? "user_regenerate" : "auto_refill",
    examType: exam_type,
  });

  let selectedBankDocs = await selectQuestionsFromBank({
    examId,
    contentHash: questionBankContentHash,
    count: effectiveQuestionCount,
    excludeHashes: excludeQuestionHashes,
  });

  if (selectedBankDocs.length < effectiveQuestionCount && excludeQuestionHashes.length) {
    const immediatePreviousHashes =
      cacheMatchesCurrentBank && Array.isArray(existingCache?.questionHashes)
        ? uniqueStrings(existingCache.questionHashes)
        : [];

    selectedBankDocs = await selectQuestionsFromBank({
      examId,
      contentHash: questionBankContentHash,
      count: effectiveQuestionCount,
      excludeHashes: immediatePreviousHashes,
    });
  }

  if (selectedBankDocs.length < effectiveQuestionCount) {
    await ensureQuestionBankCapacity({
      exam,
      contentHash: questionBankContentHash,
      requiredCount: effectiveQuestionCount,
      excludeHashes: [],
      initiatedBy: req.user?._id || null,
      trigger: recreate ? "user_regenerate" : "auto_refill",
      examType: exam_type,
    });

    selectedBankDocs = await selectQuestionsFromBank({
      examId,
      contentHash: questionBankContentHash,
      count: effectiveQuestionCount,
      excludeHashes:
        cacheMatchesCurrentBank && Array.isArray(existingCache?.questionHashes)
          ? uniqueStrings(existingCache.questionHashes)
          : [],
    });
  }

  if (selectedBankDocs.length < effectiveQuestionCount) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      "Question bank does not have enough approved questions yet. Please retry shortly."
    );
  }

  const selectedQuestions = selectedBankDocs.map((doc) => doc.question);
  const selectedQuestionHashes = uniqueStrings(
    selectedBankDocs.map((doc) => doc.questionHash)
  );
  const previousServedHashes = cacheMatchesCurrentBank
    ? uniqueStrings(existingCache?.servedQuestionHashes || [])
    : [];
  const nextServedQuestionHashes = uniqueStrings([
    ...previousServedHashes,
    ...selectedQuestionHashes,
  ]);

  const bankStartTime = new Date();
  const bankEndTime =
    durationMinutes && durationMinutes > 0
      ? new Date(bankStartTime.getTime() + durationMinutes * 60 * 1000)
      : null;

  const bankCacheDoc = await ExamQuestionCache.findOneAndUpdate(
    { userId, examId },
    {
      userId,
      examId,
      examName: exam.name,
      sheetContent: exam.effectivitySheetContent || "",
      knowledgeContent: exam.bodyOfKnowledgeContent || "",
      n_question: effectiveQuestionCount,
      durationMinutes,
      startTime: bankStartTime,
      endTime: bankEndTime,
      status: "success",
      statusCode: httpStatus.OK,
      questions: selectedQuestions,
      questionHashes: selectedQuestionHashes,
      servedQuestionHashes: nextServedQuestionHashes,
      questionBankContentHash,
      questionSource: "question_bank",
      rawResponse: {
        source: "question_bank",
        contentHash: questionBankContentHash,
        selectedCount: selectedQuestions.length,
      },
      progress: defaultProgress(),
      subscriptionUsage: nextSubscriptionUsage,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await QuestionUsage.findOneAndUpdate(
    { userId, examId, monthKey },
    { $inc: { questionsUsed: effectiveQuestionCount } },
    { upsert: true }
  );

  await ExamAttempt.findOneAndUpdate(
    { userId, examId, status: "IN_PROGRESS" },
    {
      userId,
      examId,
      startedAt: bankCacheDoc.startTime || bankStartTime,
      endedAt: bankCacheDoc.endTime || null,
      status: "IN_PROGRESS",
      unansweredCount: Array.isArray(bankCacheDoc.questions)
        ? bankCacheDoc.questions.length
        : 0,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Exam started and questions fetched from question bank",
    data: {
      status: "success",
      statusCode: httpStatus.OK,
      questions: prepareQuestionsForDelivery(bankCacheDoc.questions),
      startTime: bankCacheDoc.startTime,
      endTime: bankCacheDoc.endTime,
      durationMinutes: bankCacheDoc.durationMinutes,
      fromCache: false,
      progress: bankCacheDoc.progress || defaultProgress(),
      questionUsage: nextQuestionUsage,
    },
  });
});

export const generateExamQuestionBank = catchAsync(async (req, res) => {
  const exam = await Exam.findById(req.params.id).lean();
  if (!exam) {
    throw new AppError(httpStatus.NOT_FOUND, "Exam not found");
  }

  const targetCount = parsePositiveInteger(
    req.body?.targetCount ?? req.query?.targetCount,
    QUESTION_BANK_DEFAULT_TARGET,
    "targetCount"
  );
  const batchSize = parseQuestionBankBatchSize(
    req.body?.batchSize ?? req.query?.batchSize,
    QUESTION_BANK_DEFAULT_BATCH_SIZE
  );
  const totalBatches = calculateTotalBatches(targetCount, batchSize);
  const requestedMaxBatchesPerRun = parsePositiveInteger(
    req.body?.maxBatchesPerRun ?? req.query?.maxBatchesPerRun,
    totalBatches,
    "maxBatchesPerRun"
  );
  const maxBatchesPerRun = Math.min(requestedMaxBatchesPerRun, totalBatches);

  const rawExamType =
    req.body?.exam_type ?? req.query?.exam_type ?? QUESTION_SERVICE_DEFAULT_EXAM_TYPE;
  const normalizedExamType =
    rawExamType !== undefined && rawExamType !== null
      ? rawExamType.toString().trim()
      : "";
  const examType =
    normalizedExamType && normalizedExamType.toLowerCase() !== "standard"
      ? normalizedExamType
      : QUESTION_SERVICE_DEFAULT_EXAM_TYPE;

  const contentHash = buildExamContentHash(exam);
  const summary = await generateQuestionBankInBatches({
    exam,
    contentHash,
    targetCount,
    batchSize,
    totalBatches,
    maxBatchesPerRun,
    initiatedBy: req.user?._id || null,
    trigger: "manual",
    examType,
    autoApprove: false,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: !summary.failed,
    message: summary.failed
      ? "Question bank generation completed with failures"
      : "Question bank generation completed",
    data: {
      examId: exam._id,
      examName: exam.name,
      contentHash,
      reviewRequired: true,
      ...summary,
    },
  });
});

export const getExamQuestionBankAdminStatus = catchAsync(async (req, res) => {
  const exam = await Exam.findById(req.params.id).lean();
  if (!exam) {
    throw new AppError(httpStatus.NOT_FOUND, "Exam not found");
  }

  const contentHash = buildExamContentHash(exam);
  const status = await getQuestionBankStatus({
    examId: exam._id,
    contentHash,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Exam question bank status fetched",
    data: {
      examId: exam._id,
      examName: exam.name,
      defaults: {
        targetCount: QUESTION_BANK_DEFAULT_TARGET,
        batchSize: QUESTION_BANK_DEFAULT_BATCH_SIZE,
        totalBatches: calculateTotalBatches(
          QUESTION_BANK_DEFAULT_TARGET,
          QUESTION_BANK_DEFAULT_BATCH_SIZE
        ),
      },
      ...status,
    },
  });
});

export const getExamQuestionBankQuestionsAdmin = catchAsync(async (req, res) => {
  const exam = await Exam.findById(req.params.id).lean();
  if (!exam) {
    throw new AppError(httpStatus.NOT_FOUND, "Exam not found");
  }

  const contentHash = buildExamContentHash(exam);
  const page = parsePositiveInteger(req.query?.page, 1, "page");
  const limit = Math.min(
    parsePositiveInteger(req.query?.limit, 20, "limit"),
    200
  );
  const search =
    req.query?.search !== undefined && req.query?.search !== null
      ? req.query.search.toString()
      : "";

  const data = await listQuestionBankQuestions({
    examId: exam._id,
    contentHash,
    page,
    limit,
    search,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Exam question bank questions fetched",
    data: {
      examId: exam._id,
      examName: exam.name,
      contentHash,
      ...data,
    },
  });
});

export const getExamQuestionBankReviewQuestionsAdmin = catchAsync(async (req, res) => {
  const exam = await Exam.findById(req.params.id).lean();
  if (!exam) {
    throw new AppError(httpStatus.NOT_FOUND, "Exam not found");
  }

  const contentHash = buildExamContentHash(exam);
  const page = parsePositiveInteger(req.query?.page, 1, "page");
  const limit = Math.min(
    parsePositiveInteger(req.query?.limit, 20, "limit"),
    200
  );
  const search =
    req.query?.search !== undefined && req.query?.search !== null
      ? req.query.search.toString()
      : "";

  const data = await listQuestionBankReviewQuestions({
    examId: exam._id,
    contentHash,
    page,
    limit,
    search,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Exam question bank review questions fetched",
    data: {
      examId: exam._id,
      examName: exam.name,
      contentHash,
      ...data,
    },
  });
});

export const approveExamQuestionBankReviewAdmin = catchAsync(async (req, res) => {
  const exam = await Exam.findById(req.params.id).lean();
  if (!exam) {
    throw new AppError(httpStatus.NOT_FOUND, "Exam not found");
  }

  const contentHash = buildExamContentHash(exam);
  const batchIds = Array.isArray(req.body?.batchIds)
    ? req.body.batchIds
        .map((value) => value?.toString?.().trim?.())
        .filter(Boolean)
    : [];

  const result = await approveQuestionBankReviewBatches({
    examId: exam._id,
    contentHash,
    batchIds,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Question bank review approved",
    data: {
      examId: exam._id,
      examName: exam.name,
      contentHash,
      ...result,
    },
  });
});

export const updateExam = catchAsync(async (req, res) => {
  const exam = await Exam.findById(req.params.id);
  if (!exam) throw new AppError(httpStatus.NOT_FOUND, "Exam not found");
  const previousContentHash = buildExamContentHash(exam);

  const allowedFields = [
    "name",
    "effectivitySheetContent",
    "bodyOfKnowledgeContent",
    "n_question",
    "durationMinutes",
  ];
  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) {
      if (field === "n_question") {
        exam[field] = parseQuestionCount(req.body[field]);
      } else if (field === "durationMinutes") {
        exam[field] = parseDurationMinutes(req.body[field]);
      } else {
        exam[field] = req.body[field];
      }
    }
  });

  if (req.body.status !== undefined) {
    exam.status = parseStatus(req.body.status);
  }

  if (req.file) {
    const upload = await uploadOnCloudinary(req.file.buffer);
    exam.image = { public_id: upload.public_id, url: upload.secure_url };
  }

  await exam.save();

  const updatedExamData = sanitizeExam(exam);
  const updatedContentHash = buildExamContentHash(updatedExamData);
  const contentSignatureChanged = previousContentHash !== updatedContentHash;

  let questionBankRebuild = {
    triggered: false,
    reason: contentSignatureChanged
      ? "content_changed_pending_trigger"
      : "content_unchanged",
    contentHash: updatedContentHash,
    targetCount: null,
    batchSize: null,
    totalBatches: null,
    maxBatchesPerRun: null,
  };

  if (contentSignatureChanged) {
    const autoRegenerateQuestionBank = parseBoolean(
      req.body?.autoRegenerateQuestionBank ??
        req.body?.regenerateQuestionBank ??
        req.query?.autoRegenerateQuestionBank ??
        true
    );
    const targetCount = parsePositiveInteger(
      req.body?.targetCount ?? req.query?.targetCount,
      QUESTION_BANK_DEFAULT_TARGET,
      "targetCount"
    );
    const batchSize = parseQuestionBankBatchSize(
      req.body?.batchSize ?? req.query?.batchSize,
      QUESTION_BANK_DEFAULT_BATCH_SIZE
    );
    const totalBatches = calculateTotalBatches(targetCount, batchSize);
    const requestedMaxBatchesPerRun = parsePositiveInteger(
      req.body?.maxBatchesPerRun ?? req.query?.maxBatchesPerRun,
      totalBatches,
      "maxBatchesPerRun"
    );
    const maxBatchesPerRun = Math.min(requestedMaxBatchesPerRun, totalBatches);

    const rawExamType =
      req.body?.exam_type ??
      req.query?.exam_type ??
      QUESTION_SERVICE_DEFAULT_EXAM_TYPE;
    const normalizedExamType =
      rawExamType !== undefined && rawExamType !== null
        ? rawExamType.toString().trim()
        : "";
    const examType =
      normalizedExamType && normalizedExamType.toLowerCase() !== "standard"
        ? normalizedExamType
        : QUESTION_SERVICE_DEFAULT_EXAM_TYPE;

    questionBankRebuild = {
      triggered: autoRegenerateQuestionBank,
      reason: autoRegenerateQuestionBank
        ? "content_changed_auto_regeneration_started"
        : "content_changed_auto_regeneration_disabled",
      contentHash: updatedContentHash,
      targetCount,
      batchSize,
      totalBatches,
      maxBatchesPerRun,
    };

    if (autoRegenerateQuestionBank) {
      void generateQuestionBankInBatches({
        exam: updatedExamData,
        contentHash: updatedContentHash,
        targetCount,
        batchSize,
        totalBatches,
        maxBatchesPerRun,
        initiatedBy: req.user?._id || null,
        trigger: "exam_update",
        examType,
      })
        .then((summary) => {
          console.info("[QuestionBank] exam update regeneration summary", {
            examId: updatedExamData?._id?.toString?.() || updatedExamData?._id,
            contentHash: updatedContentHash,
            approvedAfter: summary?.approvedAfter,
            insertedThisRun: summary?.insertedThisRun,
            completedTarget: summary?.completedTarget,
            failed: summary?.failed,
          });
        })
        .catch((error) => {
          console.error("[QuestionBank] exam update regeneration failed", {
            examId: updatedExamData?._id?.toString?.() || updatedExamData?._id,
            contentHash: updatedContentHash,
            message: error?.message,
          });
        });
    }
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Exam updated successfully",
    data: {
      ...updatedExamData,
      questionBankRebuild,
    },
  });
});

export const updateExamStatus = catchAsync(async (req, res) => {
  const exam = await Exam.findById(req.params.id);
  if (!exam) throw new AppError(httpStatus.NOT_FOUND, "Exam not found");

  if (req.body?.status === undefined) {
    throw new AppError(httpStatus.BAD_REQUEST, "Status is required");
  }

  exam.status = parseStatus(req.body.status);
  await exam.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Exam status updated successfully",
    data: sanitizeExam(exam),
  });
});

export const deleteExam = catchAsync(async (req, res) => {
  const exam = await Exam.findById(req.params.id);
  if (!exam) throw new AppError(httpStatus.NOT_FOUND, "Exam not found");

  await exam.deleteOne();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Exam deleted successfully",
    data: null,
  });
});

export const submitExamAnswers = catchAsync(async (req, res) => {
  const userId = req.user?._id?.toString();
  const examId = req.params.id || req.body.examId;

  if (!userId) {
    throw new AppError(httpStatus.UNAUTHORIZED, "User not authenticated");
  }
  if (!examId) {
    throw new AppError(httpStatus.BAD_REQUEST, "Exam ID is required");
  }

  const cache = await ExamQuestionCache.findOne({ userId, examId });
  if (!cache || !Array.isArray(cache.questions) || cache.questions.length === 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "No cached questions found. Start the exam first."
    );
  }

  const answers = Array.isArray(req.body?.answers)
    ? req.body.answers
    : [];
  const flaggedQuestionIds = Array.isArray(req.body?.flaggedQuestionIds)
    ? req.body.flaggedQuestionIds.map((f) => f?.toString())
    : [];
  const reviewData = req.body?.reviewData ?? null;
  const voiceAnalytics = extractVoiceAnalytics(req.body);

  const details = [];
  let correct = 0;
  let answeredCount = 0;

  cache.questions.forEach((q, index) => {
    const submitted = normalizeAnswerValue(answers[index]);
    const correctOptions = Array.isArray(q.options)
      ? q.options
          .filter((opt) => opt?.is_correct)
          .map((opt) => opt.option?.toString().trim().toLowerCase())
          .filter(Boolean)
      : [];

    const isCorrect =
      submitted.length > 0 &&
      correctOptions.length > 0 &&
      submitted.length === correctOptions.length &&
      submitted.every((val) => correctOptions.includes(val));

    if (submitted.length > 0) answeredCount += 1;

    if (isCorrect) correct += 1;

    details.push({
      questionId: extractQuestionId(q, index),
      question: q.question || q.text || `Question ${index + 1}`,
      submitted,
      correctOptions,
      isCorrect,
      timeSpentSec: toNumberOrZero(
        req.body?.timeSpent?.[index] ?? cache.progress?.timeSpentSec?.[index]
      ),
    });
  });

  const total = cache.questions.length;
  const wrong = answeredCount - correct;
  const unanswered = total - answeredCount;
  const score = {
    correct,
    incorrect: wrong,
    total: total,
    percent: total > 0 ? Number(((correct / total) * 100).toFixed(2)) : 0,
  };

  cache.lastSubmission = {
    answers,
    score,
    submittedAt: new Date(),
  };
  cache.progress = {
    answers: [],
    timeSpentSec: [],
    currentIndex: 0,
    flaggedQuestionIds: [],
    lastSavedAt: null,
  };
  await cache.save();

  const endedAt = new Date();
  await ExamAttempt.findOneAndUpdate(
    { userId, examId, status: { $in: ["IN_PROGRESS", "TIMEOUT"] } },
    {
      userId,
      examId,
      endedAt,
      status: "SUBMITTED",
      score: score.percent,
      correctCount: correct,
      wrongCount: wrong,
      unansweredCount: unanswered,
      flaggedQuestionIds,
      answers: details.map((d) => ({
        questionId: d.questionId,
        selectedKey: d.submitted,
        correctAnswer: d.correctOptions,
        isCorrect: d.isCorrect,
        timeSpentSec: d.timeSpentSec,
      })),
      reviewData,
      voiceAnalytics,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Exam submitted",
    data: {
      score,
      details,
      voiceAnalytics,
      cachedQuestionsVersion: cache.updatedAt,
    },
  });
});

export const saveExamProgress = catchAsync(async (req, res) => {
  const userId = req.user?._id?.toString();
  const examId = req.params.id || req.body.examId;

  if (!userId) {
    throw new AppError(httpStatus.UNAUTHORIZED, "User not authenticated");
  }
  if (!examId) {
    throw new AppError(httpStatus.BAD_REQUEST, "Exam ID is required");
  }

  const cache = await ExamQuestionCache.findOne({ userId, examId });
  if (!cache || !Array.isArray(cache.questions) || cache.questions.length === 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "No cached questions found. Start the exam first."
    );
  }

  const questionCount = Array.isArray(cache.questions)
    ? cache.questions.length
    : 0;

  const progress = cache.progress || {
    answers: [],
    timeSpentSec: [],
    currentIndex: 0,
    flaggedQuestionIds: [],
    lastSavedAt: null,
  };

  const incomingAnswers = Array.isArray(req.body?.answers)
    ? req.body.answers
    : null;
  const incomingTimeSpent = Array.isArray(req.body?.timeSpent)
    ? req.body.timeSpent.map(toNumberOrZero)
    : null;

  if (incomingAnswers) {
    progress.answers = mergeIndexedArray(progress.answers, incomingAnswers);
  }
  if (incomingTimeSpent) {
    progress.timeSpentSec = mergeIndexedArray(
      progress.timeSpentSec,
      incomingTimeSpent
    );
  }

  const indexValue = req.body?.questionIndex ?? req.body?.index;
  const numericIndex = Number.isFinite(Number(indexValue))
    ? Number(indexValue)
    : null;

  if (
    numericIndex !== null &&
    numericIndex >= 0 &&
    (questionCount === 0 || numericIndex < questionCount)
  ) {
    if (req.body?.answer !== undefined) {
      progress.answers = mergeIndexedArray(progress.answers, []);
      progress.answers[numericIndex] = req.body.answer;
    }
    if (req.body?.timeSpentSec !== undefined || req.body?.timeSpent !== undefined) {
      const timeValue =
        req.body?.timeSpentSec !== undefined
          ? req.body.timeSpentSec
          : req.body?.timeSpent;
      progress.timeSpentSec = mergeIndexedArray(progress.timeSpentSec, []);
      progress.timeSpentSec[numericIndex] = toNumberOrZero(timeValue);
    }
  }

  if (req.body?.currentIndex !== undefined) {
    const currentIndex = Number(req.body.currentIndex);
    if (!Number.isNaN(currentIndex) && currentIndex >= 0) {
      progress.currentIndex =
        questionCount > 0 ? Math.min(currentIndex, questionCount - 1) : currentIndex;
    }
  }

  if (Array.isArray(req.body?.flaggedQuestionIds)) {
    progress.flaggedQuestionIds = req.body.flaggedQuestionIds
      .map((f) => f?.toString())
      .filter(Boolean);
  }

  if (questionCount > 0) {
    progress.answers = Array.isArray(progress.answers)
      ? progress.answers.slice(0, questionCount)
      : [];
    progress.timeSpentSec = Array.isArray(progress.timeSpentSec)
      ? progress.timeSpentSec.slice(0, questionCount)
      : [];
  }

  progress.lastSavedAt = new Date();
  cache.progress = progress;
  await cache.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Exam progress saved",
    data: {
      progress,
      questionCount,
      cachedAt: cache.updatedAt,
    },
  });
});

export const submitExamReview = catchAsync(async (req, res) => {
  const userId = req.user?._id?.toString();
  const examId = req.params.id || req.body.examId;

  if (!userId) {
    throw new AppError(httpStatus.UNAUTHORIZED, "User not authenticated");
  }
  if (!examId) {
    throw new AppError(httpStatus.BAD_REQUEST, "Exam ID is required");
  }

  const stars = Number(req.body?.stars ?? req.body?.rating);
  if (Number.isNaN(stars)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Rating must be a number");
  }
  if (stars < 1 || stars > 5) {
    throw new AppError(httpStatus.BAD_REQUEST, "Rating must be between 1 and 5");
  }

  const feedbackText =
    req.body?.feedbackText ?? req.body?.testimonial ?? req.body?.review ?? "";
  const displayName =
    req.body?.name ??
    req.body?.displayName ??
    req.user?.name ??
    [req.user?.firstName, req.user?.lastName].filter(Boolean).join(" ") ??
    "";

  const review = await ExamRating.findOneAndUpdate(
    { userId, examId },
    {
      userId,
      examId,
      stars,
      feedbackText,
      displayName,
      status: "pending",
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Exam review saved",
    data: {
      reviewId: review._id,
      examId: review.examId,
      stars: review.stars,
      feedbackText: review.feedbackText,
      displayName: review.displayName,
      status: review.status,
      updatedAt: review.updatedAt,
    },
  });
});

export const getPublishedExamReviews = catchAsync(async (req, res) => {
  const filter = { status: "published" };
  if (req.query.examId) filter.examId = req.query.examId;

  const data = await listExamReviews(filter, req.query.page, req.query.limit);

  const examIds = [
    ...new Set(data.reviews.map((r) => r.examId?.toString()).filter(Boolean)),
  ];
  const exams = examIds.length
    ? await Exam.find({ _id: { $in: examIds } }).select("name").lean()
    : [];
  const examMap = exams.reduce((acc, exam) => {
    acc[exam._id.toString()] = exam.name;
    return acc;
  }, {});

  const reviews = data.reviews.map((review) => ({
    reviewId: review._id,
    examId: review.examId,
    examName: examMap[review.examId?.toString()] || null,
    stars: review.stars,
    feedbackText: review.feedbackText,
    displayName: review.displayName,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
  }));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Published exam reviews fetched",
    data: {
      reviews,
      meta: data.meta,
    },
  });
});

export const getAllExamReviewsAdmin = catchAsync(async (req, res) => {
  const filter = {};
  const statusFilter = parseReviewStatus(req.query.status);
  if (statusFilter) filter.status = statusFilter;
  if (req.query.examId) filter.examId = req.query.examId;
  if (req.query.userId) filter.userId = req.query.userId;

  const data = await listExamReviews(filter, req.query.page, req.query.limit);

  const examIds = [
    ...new Set(data.reviews.map((r) => r.examId?.toString()).filter(Boolean)),
  ];
  const userIds = [
    ...new Set(data.reviews.map((r) => r.userId?.toString()).filter(Boolean)),
  ];

  const [exams, users] = await Promise.all([
    examIds.length
      ? Exam.find({ _id: { $in: examIds } }).select("name").lean()
      : [],
    userIds.length
      ? User.find({ _id: { $in: userIds } })
          .select("name firstName lastName email")
          .lean()
      : [],
  ]);

  const examMap = exams.reduce((acc, exam) => {
    acc[exam._id.toString()] = exam.name;
    return acc;
  }, {});

  const userMap = users.reduce((acc, user) => {
    const name =
      user.name ||
      [user.firstName, user.lastName].filter(Boolean).join(" ") ||
      user.email ||
      "";
    acc[user._id.toString()] = { name, email: user.email || "" };
    return acc;
  }, {});

  const reviews = data.reviews.map((review) => {
    const userInfo = userMap[review.userId?.toString()] || {
      name: "",
      email: "",
    };
    return {
      reviewId: review._id,
      examId: review.examId,
      examName: examMap[review.examId?.toString()] || null,
      userId: review.userId,
      userName: userInfo.name,
      userEmail: userInfo.email,
      stars: review.stars,
      feedbackText: review.feedbackText,
      displayName: review.displayName,
      status: review.status,
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
    };
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Exam reviews fetched",
    data: {
      reviews,
      meta: data.meta,
    },
  });
});

export const updateExamReview = catchAsync(async (req, res) => {
  const reviewId = req.params.reviewId;
  if (!reviewId) {
    throw new AppError(httpStatus.BAD_REQUEST, "Review ID is required");
  }

  const updates = {};

  if (req.body?.status !== undefined) {
    updates.status = parseReviewStatus(req.body.status);
  }

  if (req.body?.stars !== undefined) {
    const stars = Number(req.body.stars);
    if (Number.isNaN(stars)) {
      throw new AppError(httpStatus.BAD_REQUEST, "Rating must be a number");
    }
    if (stars < 1 || stars > 5) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Rating must be between 1 and 5"
      );
    }
    updates.stars = stars;
  }

  if (req.body?.feedbackText !== undefined) {
    updates.feedbackText = req.body.feedbackText ?? "";
  }

  if (req.body?.displayName !== undefined) {
    updates.displayName = req.body.displayName ?? "";
  }

  if (!Object.keys(updates).length) {
    throw new AppError(httpStatus.BAD_REQUEST, "No valid updates provided");
  }

  const review = await ExamRating.findByIdAndUpdate(
    reviewId,
    { $set: updates },
    { new: true }
  );

  if (!review) {
    throw new AppError(httpStatus.NOT_FOUND, "Review not found");
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Review updated",
    data: {
      reviewId: review._id,
      examId: review.examId,
      userId: review.userId,
      stars: review.stars,
      feedbackText: review.feedbackText,
      displayName: review.displayName,
      status: review.status,
      updatedAt: review.updatedAt,
    },
  });
});

export const deleteExamReview = catchAsync(async (req, res) => {
  const reviewId = req.params.reviewId;
  if (!reviewId) {
    throw new AppError(httpStatus.BAD_REQUEST, "Review ID is required");
  }

  const review = await ExamRating.findByIdAndDelete(reviewId);
  if (!review) {
    throw new AppError(httpStatus.NOT_FOUND, "Review not found");
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Review deleted",
    data: null,
  });
});
