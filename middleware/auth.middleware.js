import jwt from "jsonwebtoken";
import httpStatus from "http-status";
import AppError from "../errors/AppError.js";
import { User } from "./../model/user.model.js";
import { isDeviceBlockingEnabled } from "../utils/deviceBlocking.js";

const INSTALLATION_HEADER_KEY = "x-app-installation-id";
const FALLBACK_INSTALLATION_HEADER_KEY = "x-installation-id";

const normalizeInstallationId = (installationId) =>
  installationId?.toString().trim() || "";

const resolveRequestInstallationId = (req) =>
  normalizeInstallationId(
    req.get(INSTALLATION_HEADER_KEY) ?? req.get(FALLBACK_INSTALLATION_HEADER_KEY)
  );

const getStoredInstallationId = (user) =>
  normalizeInstallationId(user?.activeInstallationId || user?.activeDeviceId);

const normalizeExpiredProfessionalSubscription = async (user) => {
  // Professional is now an account-level marker. ExamAccess.expiresAt controls
  // access independently, so an expired initial period must not downgrade the
  // whole account to Starter.
  return user;
};

const validateInstallationContext = (req, decoded, user) => {
  if (!isDeviceBlockingEnabled()) return;

  const requestInstallationId = resolveRequestInstallationId(req);
  const activeInstallationId = getStoredInstallationId(user);

  if (!requestInstallationId) {
    throw new AppError(httpStatus.BAD_REQUEST, "Installation identifier is required");
  }
  if (
    !decoded.iid ||
    !activeInstallationId ||
    decoded.iid !== activeInstallationId ||
    requestInstallationId !== activeInstallationId
  ) {
    throw new AppError(401, "Session expired. Please login again.");
  }
};

export const protect = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    throw new AppError(httpStatus.UNAUTHORIZED, "Token not found");
  }

  try {
    const decoded = await jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    let user = await User.findById(decoded._id);
    if (user && (await User.isOTPVerified(user._id))) {
      if (user.status !== "active") {
        throw new AppError(httpStatus.FORBIDDEN, "Account is inactive");
      }
      if (
        !decoded.sid ||
        !user.activeSessionId ||
        decoded.sid !== user.activeSessionId
      ) {
        throw new AppError(401, "Session expired. Please login again.");
      }
      validateInstallationContext(req, decoded, user);
      user = await normalizeExpiredProfessionalSubscription(user);
      req.user = user;
    } else {
      throw new AppError(401, "Invalid token");
    }
    next();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(401, "Invalid token");
  }
};

export const optionalProtect = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return next();

  try {
    const decoded = await jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    let user = await User.findById(decoded._id);
    if (user && (await User.isOTPVerified(user._id))) {
      if (user.status !== "active") {
        throw new AppError(httpStatus.FORBIDDEN, "Account is inactive");
      }
      if (
        !decoded.sid ||
        !user.activeSessionId ||
        decoded.sid !== user.activeSessionId
      ) {
        throw new AppError(401, "Session expired. Please login again.");
      }
      validateInstallationContext(req, decoded, user);
      user = await normalizeExpiredProfessionalSubscription(user);
      req.user = user;
    } else {
      throw new AppError(401, "Invalid token");
    }
    return next();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(401, "Invalid token");
  }
};

export const isAdmin = (req, res, next) => {
  const role = req.user?.role?.toString().toLowerCase();
  if (role !== "admin") {
    throw new AppError(403, "Access denied. You are not an admin.");
  }
  next();
};

export const isUser = (req, res, next) => {
  const role = req.user?.role?.toString().toLowerCase();
  if (role !== "user") {
    throw new AppError(403, "Access denied. You are not an user.");
  }
  next();
};

export const requirePermission = (permission) => (req, res, next) => {
  const role = req.user?.role?.toString().toLowerCase();
  if (role === "admin") return next();
  if (role !== "sub-admin") {
    throw new AppError(403, "Access denied. Permission required.");
  }
  const permissions = Array.isArray(req.user?.subAdminPermissions)
    ? req.user.subAdminPermissions
    : [];
  if (!permissions.includes(permission)) {
    throw new AppError(403, "Access denied. Permission required.");
  }
  next();
};

export const requireAnyPermission = (permissions = []) => (req, res, next) => {
  const role = req.user?.role?.toString().toLowerCase();
  if (role === "admin") return next();
  if (role !== "sub-admin") {
    throw new AppError(403, "Access denied. Permission required.");
  }
  const current = Array.isArray(req.user?.subAdminPermissions)
    ? req.user.subAdminPermissions
    : [];
  if (!permissions.some((p) => current.includes(p))) {
    throw new AppError(403, "Access denied. Permission required.");
  }
  next();
};
