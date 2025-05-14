"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.damaFunctionUpdate = void 0;
const https_1 = require("firebase-functions/v2/https");
const logger = __importStar(require("firebase-functions/logger"));
const admin = __importStar(require("firebase-admin"));
const dotenv = __importStar(require("dotenv"));
const googleapis_1 = require("googleapis");
dotenv.config();
const appMetadataCache = new Map();
if (!process.env.TARGET_BUCKET) {
    throw new Error("TARGET_BUCKET is not set in environment variables.");
}
admin.initializeApp();
console.log("Firebase admin initialized.");
exports.damaFunctionUpdate = (0, https_1.onCall)({
    enforceAppCheck: true,
    secrets: [],
}, async (request) => {
    const data = request.data;
    if (!data || typeof data !== "object" || Object.keys(data).length === 0) {
        throw new https_1.HttpsError("invalid-argument", "Data must be a non-empty JSON object.");
    }
    const { folderPrefix, userPseudoID, payload } = data;
    const appCheckToken = request.rawRequest.headers["x-firebase-appcheck"];
    const isEmulator = process.env.FUNCTIONS_EMULATOR === "true";
    let firebaseAppId = "emulator_app_id";
    if (isEmulator) {
        logger.debug("Running in emulator, skipping App Check verification.");
        firebaseAppId = "emulator_app_id";
    }
    else {
        if (!appCheckToken || typeof appCheckToken !== "string") {
            throw new https_1.HttpsError("unauthenticated", "App Check token is missing or malformed.");
        }
        try {
            const decodedAppCheckToken = await admin.appCheck().verifyToken(appCheckToken);
            firebaseAppId = decodedAppCheckToken.appId;
        }
        catch (err) {
            logger.error("App Check token verification failed:", err);
            throw new https_1.HttpsError("unauthenticated", "Invalid App Check token.");
        }
    }
    if (!payload || typeof payload !== "object" || Object.keys(payload).length === 0) {
        throw new https_1.HttpsError("invalid-argument", "Payload must be a non-empty JSON object.");
    }
    if (!folderPrefix || !userPseudoID) {
        throw new https_1.HttpsError("invalid-argument", "Missing folderPrefix or userPseudoID in the payload.");
    }
    const projectId = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT;
    if (!projectId) {
        logger.error("Project ID is not set. Ensure GCP_PROJECT or GCLOUD_PROJECT is defined in the environment.");
        throw new https_1.HttpsError("internal", "Missing project ID configuration.");
    }
    const appInfo = await mapAppIdToAppDetails(projectId, firebaseAppId);
    const platformId = appInfo.platformId;
    const filePath = generateFilePath(userPseudoID, folderPrefix, platformId);
    logger.log("Saving Payload data to:", filePath);
    const bucketName = process.env.TARGET_BUCKET;
    console.log("TARGET_BUCKET:", bucketName);
    if (!bucketName) {
        throw new https_1.HttpsError("internal", "TARGET_BUCKET environment variable is not set.");
    }
    const bucket = admin.storage().bucket(bucketName);
    await checkBucketWritePermission(bucket);
    const jsonLines = JSON.stringify(JSON.parse(JSON.stringify(payload, Object.keys(payload).sort())));
    await bucket.file(filePath).save(jsonLines, {
        contentType: "application/json",
    });
    return { success: true, filePath: `gs://${bucketName}/${filePath}` };
});
async function mapAppIdToAppDetails(projectId, firebaseAppId) {
    var _a, _b;
    if (appMetadataCache.has(firebaseAppId)) {
        return appMetadataCache.get(firebaseAppId);
    }
    const auth = new googleapis_1.google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/firebase"],
    });
    const authClient = await auth.getClient();
    const firebase = new googleapis_1.firebase_v1beta1.Firebase({
        auth: authClient,
    });
    const [androidAppsRes, iosAppsRes] = await Promise.all([
        firebase.projects.androidApps.list({ parent: `projects/${projectId}` }),
        firebase.projects.iosApps.list({ parent: `projects/${projectId}` }),
    ]);
    const androidApp = (_a = androidAppsRes.data.apps) === null || _a === void 0 ? void 0 : _a.find((app) => app.appId === firebaseAppId);
    if (androidApp) {
        const result = { platformId: `ANDROID-${androidApp.packageName}` };
        appMetadataCache.set(firebaseAppId, result);
        return result;
    }
    const iosApp = (_b = iosAppsRes.data.apps) === null || _b === void 0 ? void 0 : _b.find((app) => app.appId === firebaseAppId);
    if (iosApp) {
        const rawId = iosApp.appStoreId ? iosApp.appStoreId : iosApp.bundleId;
        const platformId = `IOS-${rawId}`;
        const result = { platformId: platformId };
        appMetadataCache.set(firebaseAppId, result);
        return result;
    }
    return { platformId: "unknown_platform_id" };
}
async function checkBucketWritePermission(bucket) {
    var _a;
    const tempFilePath = `.permission_check/${Date.now()}.tmp`;
    const tempFile = bucket.file(tempFilePath);
    try {
        await tempFile.save("test", {
            contentType: "text/plain",
            resumable: false,
        });
        await tempFile.delete();
    }
    catch (err) {
        logger.error("Permission check failed:", err);
        const errorCode = (err === null || err === void 0 ? void 0 : err.code) || (err === null || err === void 0 ? void 0 : err.status);
        if (errorCode === 403 || errorCode === 401 || ((_a = err === null || err === void 0 ? void 0 : err.message) === null || _a === void 0 ? void 0 : _a.includes("permission"))) {
            throw new https_1.HttpsError("permission-denied", "The project does not have permission to write to the specified bucket.");
        }
        throw new https_1.HttpsError("internal", "Failed to verify bucket access. Reason: " + ((err === null || err === void 0 ? void 0 : err.message) || "Unknown error"));
    }
}
function generateFilePath(userPseudoID, folderPrefix, appId) {
    const normalizedUserId = userPseudoID.toUpperCase().replace(/-/g, "");
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const min = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const datePath = `${yyyy}${mm}${dd}`;
    const timestamp = `${yyyy}${mm}${dd}T${hh}${min}${ss}`;
    const fileName = `${normalizedUserId}-${timestamp}.json`;
    const filePath = `${folderPrefix}/${datePath}/${appId}/${fileName}`;
    return filePath;
}
//# sourceMappingURL=index.js.map