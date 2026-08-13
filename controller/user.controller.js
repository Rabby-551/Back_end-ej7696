import httpStatus from "http-status";
import { User } from "../model/user.model.js";
import { ExamAccess } from "../model/examAccess.model.js";
import { Exam } from "../model/exam.model.js";
import { ExamAttempt } from "../model/examAttempt.model.js";
import { ExamRating } from "../model/examRating.model.js";
import { AppSetting } from "../model/appSetting.model.js";
import { ResourceProduct } from "../model/resourceProduct.model.js";
import { ResourcePurchase } from "../model/resourcePurchase.model.js";
import { ProfessionalPlanPurchase } from "../model/professionalPlanPurchase.model.js";
import { generateOTP, uploadOnCloudinary } from "../utils/commonMethod.js";
import AppError from "../errors/AppError.js";
import sendResponse from "../utils/sendResponse.js";
import catchAsync from "../utils/catchAsync.js";
import { createToken } from "../utils/authToken.js";
import { sendEmail } from "../utils/sendEmail.js";
import {
  getUnlockCodesForProduct,
  getUnlockedResourceCodeSet,
  normalizeProductCode,
} from "../utils/resource.service.js";
import {
  buildExamUnlockSummary,
} from "../utils/examAccess.helpers.js";
import { expireExamEntitlements } from "../utils/examSubscription.service.js";

const safeUserSelect =
  "-password -refreshToken -verificationInfo -password_reset_token";
const PROFESSIONAL_SUBSCRIPTION_MONTHS = 6;
const SESSION_CLEAR_UPDATE = {
  refreshToken: "",
  activeSessionId: "",
  activeDeviceId: "",
  activeInstallationId: "",
};

const SUB_ADMIN_PERMISSIONS = [
  "view_user_list",
  "send_password_reset_email",
  "suspend_users",
  "manage_exams_questions",
  "view_billing_summary",
  "edit_user_profiles",
  "manage_subscription",
  "manage_announcements",
  "access_performance_analytics",
  "view_activity_logs",
  "manual_exam_unlocks",
  "credential_management",
  "manage_resource_store",
  "manage_referral_payouts",
  "view_referral_analytics",
];

const parseStatus = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = value.toString().toLowerCase();
  if (!["active", "inactive"].includes(normalized)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Status must be active or inactive");
  }
  return normalized;
};

const parseRole = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = value.toString().toLowerCase();
  if (!["user", "admin", "sub-admin", "storeman"].includes(normalized)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Role must be user, sub-admin, admin, or storeman"
    );
  }
  return normalized;
};

const parseTier = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = value.toString().toLowerCase();
  if (!["starter", "professional"].includes(normalized)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Subscription tier must be starter or professional"
    );
  }
  return normalized;
};

const parsePermissions = (value) => {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const normalized = raw
    .map((p) => p?.toString().trim().toLowerCase())
    .filter(Boolean);
  const invalid = normalized.filter((p) => !SUB_ADMIN_PERMISSIONS.includes(p));
  if (invalid.length) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Invalid permissions: ${invalid.join(", ")}`
    );
  }
  return [...new Set(normalized)];
};

const parseIfJson = (value, fieldName) => {
  if (typeof value !== "string") return value;
  if (value.trim() === "") return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Invalid JSON for ${fieldName}`
    );
  }
};

const normalizePlanIntervalUnit = (unit) => {
  const value = unit?.toString().trim().toLowerCase();
  if (!value) return "months";
  if (["month", "months"].includes(value)) return "months";
  if (["year", "years"].includes(value)) return "years";
  if (["week", "weeks"].includes(value)) return "weeks";
  if (["day", "days"].includes(value)) return "days";
  return "months";
};

const addInterval = (date, count, unit) => {
  const normalizedUnit = normalizePlanIntervalUnit(unit);
  const result = new Date(date);

  if (normalizedUnit === "years") {
    result.setFullYear(result.getFullYear() + count);
    return result;
  }

  if (normalizedUnit === "weeks") {
    result.setDate(result.getDate() + count * 7);
    return result;
  }

  if (normalizedUnit === "days") {
    result.setDate(result.getDate() + count);
    return result;
  }

  result.setMonth(result.getMonth() + count);
  return result;
};

const getProfessionalPlanIntervalSettings = async () => {
  const settings = await AppSetting.findOne()
    .select("professionalPlanIntervalCount professionalPlanIntervalUnit")
    .lean();

  const count = Number(settings?.professionalPlanIntervalCount);

  return {
    count:
      Number.isFinite(count) && count > 0
        ? Math.ceil(count)
        : PROFESSIONAL_SUBSCRIPTION_MONTHS,
    unit: normalizePlanIntervalUnit(settings?.professionalPlanIntervalUnit),
  };
};

const buildInstallationSessionData = (user) => ({
  userId: user._id,
  activeDeviceId: user.activeDeviceId || "",
  activeInstallationId: user.activeInstallationId || "",
  hasActiveInstallation: Boolean(user.activeDeviceId || user.activeInstallationId),
});

const RESOURCE_SOURCE_LABELS = {
  manual: "Manual unlock",
  single: "Paid unlock",
  bundle: "Paid bundle",
  professional_upgrade_addon: "Plan upgrade add-on",
  exam_unlock_addon: "Exam unlock add-on",
};

const getResourceUnlockSourceLabel = (purchaseType) =>
  RESOURCE_SOURCE_LABELS[purchaseType] || "Paid/plan-based";

const buildUnlockedResources = async (user) => {
  const unlockedCodeSet = getUnlockedResourceCodeSet(user);
  const unlockedCodes = [...unlockedCodeSet];

  if (!unlockedCodes.length) {
    return {
      resourceUnlocks: [],
      unlockedResources: [],
      unlockedResourceCount: 0,
    };
  }

  const [products, purchases] = await Promise.all([
    ResourceProduct.find({
      $or: [
        { code: { $in: unlockedCodes } },
        { bundleIncludes: { $in: unlockedCodes } },
      ],
    })
      .populate("categoryId", "title slug")
      .lean(),
    ResourcePurchase.find({
      userId: user._id,
      status: "completed",
    })
      .sort({ purchasedAt: -1, createdAt: -1 })
      .populate({
        path: "productId",
        select: "title code isBundle bundleIncludes categoryId",
        populate: { path: "categoryId", select: "title slug" },
      })
      .lean(),
  ]);

  const productByCode = new Map();
  products.forEach((product) => {
    const code = normalizeProductCode(product?.code);
    if (!code) return;
    productByCode.set(code, product);
  });

  const unlockInfoByCode = new Map();
  purchases.forEach((purchase) => {
    const purchaseProduct =
      purchase?.productId && typeof purchase.productId === "object"
        ? purchase.productId
        : null;
    const purchaseProductCode = normalizeProductCode(
      purchaseProduct?.code || purchase?.productCode
    );

    if (!purchaseProductCode) return;

    const grantedCodes = purchaseProduct
      ? getUnlockCodesForProduct(purchaseProduct)
      : [purchaseProductCode];

    grantedCodes.forEach((code) => {
      if (!unlockedCodeSet.has(code) || unlockInfoByCode.has(code)) return;

      unlockInfoByCode.set(code, {
        purchaseType: purchase.purchaseType || null,
        provider: purchase.provider || null,
        status: purchase.status || null,
        purchasedAt: purchase.purchasedAt || purchase.createdAt || null,
        sourceProductCode: purchaseProductCode,
        sourceProductTitle:
          purchaseProduct?.title ||
          productByCode.get(purchaseProductCode)?.title ||
          purchaseProductCode,
        isInherited: code !== purchaseProductCode,
      });
    });
  });

  const unlockedResources = unlockedCodes
    .map((code) => {
      const product = productByCode.get(code) || null;
      const unlockInfo = unlockInfoByCode.get(code) || null;
      const category =
        product?.categoryId && typeof product.categoryId === "object"
          ? product.categoryId
          : null;
      const isManual = !unlockInfo || unlockInfo.purchaseType === "manual";

      return {
        productId: product?._id || null,
        productCode: code,
        title: product?.title || code,
        categoryId: category?._id || product?.categoryId || null,
        categoryTitle: category?.title || "",
        isBundle: Boolean(product?.isBundle),
        isManual,
        unlockMode: isManual ? "manual" : "paid_or_plan",
        sourceLabel: isManual
          ? "Manual unlock"
          : getResourceUnlockSourceLabel(unlockInfo?.purchaseType),
        purchaseType: unlockInfo?.purchaseType || "manual",
        provider: unlockInfo?.provider || (isManual ? "manual" : null),
        status: unlockInfo?.status || (isManual ? "completed" : null),
        purchasedAt: unlockInfo?.purchasedAt || null,
        sourceProductCode: unlockInfo?.sourceProductCode || code,
        sourceProductTitle:
          unlockInfo?.sourceProductTitle || product?.title || code,
        inheritedFromBundle: Boolean(unlockInfo?.isInherited),
      };
    })
    .sort((a, b) => {
      const byCategory = String(a.categoryTitle || "").localeCompare(
        String(b.categoryTitle || "")
      );
      if (byCategory !== 0) return byCategory;
      return String(a.title || "").localeCompare(String(b.title || ""));
    });

  return {
    resourceUnlocks: unlockedCodes,
    unlockedResources,
    unlockedResourceCount: unlockedResources.length,
  };
};

export const getProfile = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id).select(safeUserSelect);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Profile fetched",
    data: user,
  });
});

export const getMyInstallationSession = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id).select(
    "activeDeviceId activeInstallationId"
  );
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Installation session fetched",
    data: buildInstallationSessionData(user),
  });
});

export const getMyUnlocks = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id).select(safeUserSelect).lean();
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  await expireExamEntitlements({ userId: user._id });

  const accesses = await ExamAccess.find({
    userId: user._id,
    status: { $in: ["active", "expired", "revoked", "unlocked"] },
  }).lean();

  const examIds = [
    ...new Set(accesses.map((access) => access.examId?.toString()).filter(Boolean)),
  ];
  const exams = examIds.length
    ? await Exam.find({ _id: { $in: examIds } }).select("name image.url").lean()
    : [];
  const examMap = exams.reduce((acc, exam) => {
    acc[exam._id.toString()] = exam.name;
    return acc;
  }, {});
  const examImageMap = exams.reduce((acc, exam) => {
    acc[exam._id.toString()] = exam.image?.url || null;
    return acc;
  }, {});

  const ownedExams = accesses.map((access) =>
    buildExamUnlockSummary({
      access,
      examMap,
      examImageMap,
      user,
    })
  );
  const unlockedExams = ownedExams.filter((exam) => exam.unlocked);

  const resourceAccess = await buildUnlockedResources(user);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "User unlocks fetched",
    data: {
      unlockedExams,
      unlockedExamCount: unlockedExams.length,
      ownedExams,
      ownedExamCount: ownedExams.length,
      ...resourceAccess,
    },
  });
});

export const getUsers = catchAsync(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);
  const skip = (page - 1) * limit;

  const filter = {};
  const statusFilter = parseStatus(req.query.status);
  if (statusFilter) filter.status = statusFilter;
  const roleFilter = parseRole(req.query.role);
  if (roleFilter) filter.role = roleFilter;
  const tierFilter = parseTier(req.query.tier);
  if (tierFilter) filter.subscriptionTier = tierFilter;

  const [users, total] = await Promise.all([
    User.find(filter)
      .select(safeUserSelect)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
  ]);

  const totalPages = Math.ceil(total / limit) || 1;

  const userIds = users.map((u) => u._id);
  const accesses = userIds.length
    ? await ExamAccess.find({
        userId: { $in: userIds },
        status: { $in: ["active", "unlocked"] },
      }).lean()
    : [];

  const examIds = [
    ...new Set(accesses.map((access) => access.examId?.toString()).filter(Boolean)),
  ];

  const exams = examIds.length
    ? await Exam.find({ _id: { $in: examIds } }).select("name").lean()
    : [];

  const examMap = exams.reduce((acc, exam) => {
    acc[exam._id.toString()] = exam.name;
    return acc;
  }, {});
  const userById = users.reduce((acc, user) => {
    acc[user._id.toString()] = user;
    return acc;
  }, {});

  const unlockedMap = accesses.reduce((acc, access) => {
    const key = access.userId.toString();
    if (!acc[key]) acc[key] = [];
    acc[key].push(
      buildExamUnlockSummary({
        access,
        examMap,
        user: userById[key] || null,
      })
    );
    return acc;
  }, {});

  const scoreMatch = userIds.length
    ? { userId: { $in: userIds }, score: { $ne: null } }
    : null;

  const [overallAgg, perExamAgg] = scoreMatch
    ? await Promise.all([
        ExamAttempt.aggregate([
          { $match: scoreMatch },
          {
            $group: {
              _id: "$userId",
              avgScore: { $avg: "$score" },
              attempts: { $sum: 1 },
            },
          },
        ]),
        ExamAttempt.aggregate([
          { $match: scoreMatch },
          {
            $group: {
              _id: { userId: "$userId", examId: "$examId" },
              avgScore: { $avg: "$score" },
              attempts: { $sum: 1 },
            },
          },
        ]),
      ])
    : [[], []];

  const overallMap = overallAgg.reduce((acc, item) => {
    acc[item._id.toString()] = {
      avgScore: Number((item.avgScore ?? 0).toFixed(2)),
      attempts: item.attempts || 0,
    };
    return acc;
  }, {});

  const perExamIds = [
    ...new Set(
      perExamAgg
        .map((item) => item?._id?.examId?.toString())
        .filter(Boolean)
    ),
  ];
  const perExamDocs = perExamIds.length
    ? await Exam.find({ _id: { $in: perExamIds } }).select("name").lean()
    : [];
  const perExamNameMap = perExamDocs.reduce((acc, exam) => {
    acc[exam._id.toString()] = exam.name;
    return acc;
  }, {});

  const perExamMap = perExamAgg.reduce((acc, item) => {
    const userKey = item?._id?.userId?.toString();
    const examKey = item?._id?.examId?.toString();
    if (!userKey || !examKey) return acc;
    if (!acc[userKey]) acc[userKey] = [];
    acc[userKey].push({
      examId: item._id.examId,
      examName: perExamNameMap[examKey] || null,
      avgScore: Number((item.avgScore ?? 0).toFixed(2)),
      attempts: item.attempts || 0,
    });
    return acc;
  }, {});

  const enrichedUsers = users.map((user) => {
    const unlockedExams = unlockedMap[user._id.toString()] || [];
    const scoreInfo = overallMap[user._id.toString()];
    const avgScoreByExam = perExamMap[user._id.toString()] || [];
    return {
      ...user,
      unlockedExams,
      unlockedExamCount: unlockedExams.length,
      avgScore: scoreInfo?.avgScore ?? 0,
      avgScoreByExam,
    };
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Users fetched",
    data: {
      users: enrichedUsers,
      meta: {
        page,
        limit,
        total,
        totalPages,
      },
    },
  });
});

export const getUserDetails = catchAsync(async (req, res) => {
  const user = await User.findById(req.params.id).select(safeUserSelect).lean();

  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");

  const accesses = await ExamAccess.find({
    userId: user._id,
    status: { $in: ["active", "unlocked"] },
  }).lean();

  const examIds = [
    ...new Set(accesses.map((access) => access.examId?.toString()).filter(Boolean)),
  ];
  const exams = examIds.length
    ? await Exam.find({ _id: { $in: examIds } }).select("name").lean()
    : [];
  const examMap = exams.reduce((acc, exam) => {
    acc[exam._id.toString()] = exam.name;
    return acc;
  }, {});

  const unlockedExams = accesses.map((access) =>
    buildExamUnlockSummary({
      access,
      examMap,
      user,
    })
  );

  const [overallAgg, perExamAgg, resourceAccess] = await Promise.all([
    ExamAttempt.aggregate([
      { $match: { userId: user._id, score: { $ne: null } } },
      {
        $group: {
          _id: "$userId",
          avgScore: { $avg: "$score" },
          attempts: { $sum: 1 },
        },
      },
    ]),
    ExamAttempt.aggregate([
      { $match: { userId: user._id, score: { $ne: null } } },
      {
        $group: {
          _id: { userId: "$userId", examId: "$examId" },
          avgScore: { $avg: "$score" },
          attempts: { $sum: 1 },
        },
      },
    ]),
    buildUnlockedResources(user),
  ]);

  const avgScore = overallAgg.length
    ? Number((overallAgg[0].avgScore ?? 0).toFixed(2))
    : 0;

  const perExamIds = [
    ...new Set(
      perExamAgg
        .map((item) => item?._id?.examId?.toString())
        .filter(Boolean)
    ),
  ];
  const perExamDocs = perExamIds.length
    ? await Exam.find({ _id: { $in: perExamIds } }).select("name").lean()
    : [];
  const perExamNameMap = perExamDocs.reduce((acc, exam) => {
    acc[exam._id.toString()] = exam.name;
    return acc;
  }, {});

  const avgScoreByExam = perExamAgg.map((item) => {
    const examKey = item?._id?.examId?.toString();
    return {
      examId: item._id.examId,
      examName: examKey ? perExamNameMap[examKey] || null : null,
      avgScore: Number((item.avgScore ?? 0).toFixed(2)),
      attempts: item.attempts || 0,
    };
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "User details fetched",
    data: {
      ...user,
      unlockedExams,
      unlockedExamCount: unlockedExams.length,
      ...resourceAccess,
      avgScore,
      avgScoreByExam,
    },
  });
});

export const getUserInstallationSession = catchAsync(async (req, res) => {
  const user = await User.findById(req.params.id).select(
    "activeDeviceId activeInstallationId"
  );
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "User installation session fetched",
    data: buildInstallationSessionData(user),
  });
});

export const clearUserInstallationSession = catchAsync(async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.id, SESSION_CLEAR_UPDATE, {
    new: true,
  }).select("activeDeviceId activeInstallationId");
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "User installation session cleared successfully",
    data: buildInstallationSessionData(user),
  });
});

export const getUserExamReviews = catchAsync(async (req, res) => {
  const userId = req.params.id;
  if (!userId) {
    throw new AppError(httpStatus.BAD_REQUEST, "User ID is required");
  }

  const reviews = await ExamRating.find({ userId })
    .sort({ updatedAt: -1 })
    .lean();

  const examIds = [
    ...new Set(reviews.map((r) => r.examId?.toString()).filter(Boolean)),
  ];
  const exams = examIds.length
    ? await Exam.find({ _id: { $in: examIds } }).select("name").lean()
    : [];
  const examMap = exams.reduce((acc, exam) => {
    acc[exam._id.toString()] = exam.name;
    return acc;
  }, {});

  const data = reviews.map((review) => ({
    reviewId: review._id,
    examId: review.examId,
    examName: examMap[review.examId?.toString()] || null,
    stars: review.stars,
    feedbackText: review.feedbackText,
    displayName: review.displayName,
    status: review.status,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
  }));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "User exam reviews fetched",
    data,
  });
});

export const deleteUser = catchAsync(async (req, res) => {
  const deletedUser = await User.findByIdAndDelete(req.params.id);

  if (!deletedUser) throw new AppError(httpStatus.NOT_FOUND, "User not found");

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "User deleted successfully",
    data: null,
  });
});

export const bulkDeleteUsers = catchAsync(async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new AppError(httpStatus.BAD_REQUEST, "User IDs are required");
  }
  const result = await User.deleteMany({ _id: { $in: ids } });
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: `${result.deletedCount} user(s) deleted successfully`,
    data: { deletedCount: result.deletedCount },
  });
});

export const getRefundedUsers = catchAsync(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);
  const skip = (page - 1) * limit;

  const refundFilter = { refundStatus: { $in: ["partial", "full"] } };
  const [planRefundedIds, resourceRefundedIds] = await Promise.all([
    ProfessionalPlanPurchase.distinct("userId", refundFilter),
    ResourcePurchase.distinct("userId", refundFilter),
  ]);

  const seen = new Set();
  const refundedUserIds = [];
  for (const id of [...planRefundedIds, ...resourceRefundedIds]) {
    const key = id.toString();
    if (!seen.has(key)) {
      seen.add(key);
      refundedUserIds.push(id);
    }
  }

  if (refundedUserIds.length === 0) {
    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Refunded users fetched",
      data: { users: [], meta: { page, limit, total: 0, totalPages: 1 } },
    });
  }

  const filter = { _id: { $in: refundedUserIds } };
  const statusFilter = parseStatus(req.query.status);
  if (statusFilter) filter.status = statusFilter;
  const roleFilter = parseRole(req.query.role);
  if (roleFilter) filter.role = roleFilter;
  const tierFilter = parseTier(req.query.tier);
  if (tierFilter) filter.subscriptionTier = tierFilter;

  const [users, total] = await Promise.all([
    User.find(filter)
      .select(safeUserSelect)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
  ]);

  const totalPages = Math.ceil(total / limit) || 1;

  const userIds = users.map((u) => u._id);
  const accesses = userIds.length
    ? await ExamAccess.find({
        userId: { $in: userIds },
        status: { $in: ["active", "expired", "revoked", "unlocked"] },
      }).lean()
    : [];

  const examIds = [
    ...new Set(accesses.map((a) => a.examId?.toString()).filter(Boolean)),
  ];
  const exams = examIds.length
    ? await Exam.find({ _id: { $in: examIds } }).select("name").lean()
    : [];
  const examMap = exams.reduce((acc, exam) => {
    acc[exam._id.toString()] = exam.name;
    return acc;
  }, {});
  const userById = users.reduce((acc, u) => {
    acc[u._id.toString()] = u;
    return acc;
  }, {});

  const unlockedMap = accesses.reduce((acc, access) => {
    const key = access.userId.toString();
    if (!acc[key]) acc[key] = [];
    acc[key].push(buildExamUnlockSummary({ access, examMap, user: userById[key] || null }));
    return acc;
  }, {});

  const scoreMatch = userIds.length ? { userId: { $in: userIds }, score: { $ne: null } } : null;
  const [overallAgg, perExamAgg] = scoreMatch
    ? await Promise.all([
        ExamAttempt.aggregate([
          { $match: scoreMatch },
          { $group: { _id: "$userId", avgScore: { $avg: "$score" }, attempts: { $sum: 1 } } },
        ]),
        ExamAttempt.aggregate([
          { $match: scoreMatch },
          { $group: { _id: { userId: "$userId", examId: "$examId" }, avgScore: { $avg: "$score" }, attempts: { $sum: 1 } } },
        ]),
      ])
    : [[], []];

  const overallMap = overallAgg.reduce((acc, item) => {
    acc[item._id.toString()] = {
      avgScore: Number((item.avgScore ?? 0).toFixed(2)),
      attempts: item.attempts || 0,
    };
    return acc;
  }, {});

  const perExamIds = [
    ...new Set(perExamAgg.map((item) => item?._id?.examId?.toString()).filter(Boolean)),
  ];
  const perExamDocs = perExamIds.length
    ? await Exam.find({ _id: { $in: perExamIds } }).select("name").lean()
    : [];
  const perExamNameMap = perExamDocs.reduce((acc, exam) => {
    acc[exam._id.toString()] = exam.name;
    return acc;
  }, {});

  const perExamMap = perExamAgg.reduce((acc, item) => {
    const userKey = item?._id?.userId?.toString();
    const examKey = item?._id?.examId?.toString();
    if (!userKey || !examKey) return acc;
    if (!acc[userKey]) acc[userKey] = [];
    acc[userKey].push({
      examId: item._id.examId,
      examName: perExamNameMap[examKey] || null,
      avgScore: Number((item.avgScore ?? 0).toFixed(2)),
      attempts: item.attempts || 0,
    });
    return acc;
  }, {});

  const enrichedUsers = users.map((user) => {
    const unlockedExams = unlockedMap[user._id.toString()] || [];
    const scoreInfo = overallMap[user._id.toString()];
    const avgScoreByExam = perExamMap[user._id.toString()] || [];
    return {
      ...user,
      unlockedExams,
      unlockedExamCount: unlockedExams.length,
      avgScore: scoreInfo?.avgScore ?? 0,
      avgScoreByExam,
    };
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Refunded users fetched",
    data: { users: enrichedUsers, meta: { page, limit, total, totalPages } },
  });
});

export const updateUserStatus = catchAsync(async (req, res) => {
  const status = parseStatus(req.body.status);
  if (!status) {
    throw new AppError(httpStatus.BAD_REQUEST, "Status is required");
  }

  const user = await User.findById(req.params.id);
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");

  user.status = status;
  await user.save();

  const sanitizedUser = await User.findById(req.params.id).select(safeUserSelect);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "User status updated",
    data: sanitizedUser,
  });
});

export const updateUserSubscription = catchAsync(async (req, res) => {
  const tier = parseTier(req.body.subscriptionTier);
  if (!tier) {
    throw new AppError(httpStatus.BAD_REQUEST, "Subscription tier is required");
  }

  const user = await User.findById(req.params.id);
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");

  user.subscriptionTier = tier;
  if (tier === "professional") {
    const { count, unit } = await getProfessionalPlanIntervalSettings();
    const subscriptionStartedAt = new Date();
    const subscriptionExpiresAt = addInterval(subscriptionStartedAt, count, unit);
    user.subscriptionStartedAt = subscriptionStartedAt;
    user.subscriptionExpiresAt = subscriptionExpiresAt;
    user.subscriptionProvider = "manual";
    user.subscriptionExternalId = "";
    user.subscriptionWillRenew = false;
  } else {
    user.subscriptionStartedAt = null;
    user.subscriptionExpiresAt = null;
    user.subscriptionProvider = "";
    user.subscriptionExternalId = "";
    user.subscriptionWillRenew = null;
  }
  await user.save();

  const sanitizedUser = await User.findById(req.params.id).select(safeUserSelect);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "User subscription updated",
    data: sanitizedUser,
  });
});

export const updateSubAdminPermissions = catchAsync(async (req, res) => {
  const permissions = parsePermissions(req.body.permissions);
  if (!permissions) {
    throw new AppError(httpStatus.BAD_REQUEST, "Permissions are required");
  }

  const user = await User.findById(req.params.id);
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");
  if (user.role !== "sub-admin") {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Permissions can only be set for sub-admin users"
    );
  }

  user.subAdminPermissions = permissions;
  await user.save();

  const sanitizedUser = await User.findById(req.params.id).select(safeUserSelect);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Sub-admin permissions updated",
    data: sanitizedUser,
  });
});

export const adminSendPasswordResetEmail = catchAsync(async (req, res) => {
  const userId = req.params.id;
  if (!userId) {
    throw new AppError(httpStatus.BAD_REQUEST, "User ID is required");
  }

  const user = await User.findById(userId).select("+password_reset_token");
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  const otp = generateOTP();
  const otpToken = createToken(
    { otp },
    process.env.OTP_SECRET,
    process.env.OTP_EXPIRE
  );

  user.password_reset_token = otpToken;
  await user.save();

  await sendEmail(user.email, "Reset Password", `Your OTP is ${otp}`);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Password reset email sent",
    data: null,
  });
});

export const adminSetTemporaryPassword = catchAsync(async (req, res) => {
  const password = req.body?.password ?? req.body?.tempPassword;
  if (!password) {
    throw new AppError(httpStatus.BAD_REQUEST, "Password is required");
  }

  const user = await User.findById(req.params.id).select("+password");
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");

  user.password = password;
  user.mustChangePassword = true;
  await user.save();

  const sanitizedUser = await User.findById(req.params.id).select(safeUserSelect);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Temporary password set",
    data: sanitizedUser,
  });
});

export const updateProfile = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id);

  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");

  if (req.body.email !== undefined) {
    const nextEmail = req.body.email?.toString().trim();
    if (!nextEmail) {
      throw new AppError(httpStatus.BAD_REQUEST, "Email is required");
    }
    if (nextEmail !== user.email) {
      const existingUser = await User.findOne({ email: nextEmail });
      if (existingUser && existingUser._id.toString() !== user._id.toString()) {
        throw new AppError(
          httpStatus.BAD_REQUEST,
          "Email already exists, please try another email"
        );
      }
      user.email = nextEmail;
    }
  }

  const editableFields = [
    "firstName",
    "lastName",
    "name",
    "username",
    "phone",
    "bio",
    "gender",
    "selfDescription",
    "dob",
    "height",
    "sexualOrientation",
    "personalityType",
    "religion",
    "lookingFor",
    "interests",
    "location",
    "language",
    "country",
    "notifications",
    "addresses",
  ];

  editableFields.forEach((field) => {
    if (req.body[field] !== undefined) {
      let value = req.body[field];

      if (["lookingFor", "interests", "addresses"].includes(field)) {
        value = parseIfJson(value, field);
      }

      if (field === "notifications") {
        value =
          typeof value === "string"
            ? value.toLowerCase() === "true"
            : Boolean(value);
      }

      if (field === "dob" && value) {
        const parsedDate = new Date(value);
        if (Number.isNaN(parsedDate.getTime())) {
          throw new AppError(httpStatus.BAD_REQUEST, "Invalid date for dob");
        }
        value = parsedDate;
      }

      user[field] = value;
    }
  });

  if (req.file) {
    const upload = await uploadOnCloudinary(req.file.buffer);
    user.avatar = { public_id: upload.public_id, url: upload.secure_url };
  }

  await user.save();

  const updatedUser = await User.findById(req.user._id).select(safeUserSelect);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Profile updated successfully",
    data: updatedUser,
  });
});

export const changePassword = catchAsync(async (req, res) => {
  const currentPassword = req.body?.currentPassword ?? req.body?.oldPassword;
  const newPassword = req.body?.newPassword;
  const confirmPassword = req.body?.confirmPassword;

  if (confirmPassword !== undefined && newPassword !== confirmPassword)
    throw new AppError(httpStatus.BAD_REQUEST, "Passwords don't match");

  const user = await User.findById(req.user._id).select("+password");

  if (!(await User.isPasswordMatched(currentPassword, user.password))) {
    throw new AppError(httpStatus.UNAUTHORIZED, "Current password wrong");
  }
  user.password = newPassword;
  user.mustChangePassword = false;

  await user.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Password changed",
  });
});
