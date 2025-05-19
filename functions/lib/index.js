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
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkPaymentStatus = exports.xenditPaymentCallback = exports.createQrisPayment = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const axios_1 = __importDefault(require("axios"));
const path = __importStar(require("path"));
// Initialize Firebase Admin SDK with service account key
const serviceAccount = require(path.resolve(__dirname, "../smartlockersystem-1032-firebase-adminsdk-fbsvc-0653cd57a5.json"));
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();
// Xendit secret API key from environment variable or config
const XENDIT_SECRET_API_KEY = process.env.XENDIT_SECRET_API_KEY || "";
// Xendit API base URL for sandbox
const XENDIT_API_BASE_URL = "https://api.xendit.co";
// Helper function to generate a random open code
function generateOpenCode() {
    return Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit code
}
// Helper function to create QRIS payment
exports.createQrisPayment = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "User must be authenticated.");
    }
    const { amount, external_id, payer_email } = data;
    if (!amount || !external_id || !payer_email) {
        throw new functions.https.HttpsError("invalid-argument", "Missing required payment parameters.");
    }
    try {
        const response = await axios_1.default.post(`${XENDIT_API_BASE_URL}/qr_codes`, {
            external_id,
            type: "DYNAMIC",
            callback_url: `https://${process.env.GCLOUD_PROJECT}.cloudfunctions.net/xenditPaymentCallback`,
            amount,
            payer_email,
        }, {
            auth: {
                username: XENDIT_SECRET_API_KEY,
                password: "",
            },
        });
        return {
            qr_string: response.data.qr_string,
            qr_url: response.data.qr_url,
            external_id: response.data.external_id,
            status: response.data.status,
        };
    }
    catch (error) {
        console.error("Error creating QRIS payment:", error.response?.data || error.message);
        throw new functions.https.HttpsError("internal", "Failed to create QRIS payment.");
    }
});
// Webhook endpoint to receive payment status updates from Xendit
exports.xenditPaymentCallback = functions.https.onRequest(async (req, res) => {
    try {
        // Validate Xendit signature header
        const signature = req.headers["x-callback-token"];
        if (!signature || signature !== XENDIT_SECRET_API_KEY) {
            console.warn("Invalid Xendit callback token");
            res.status(401).send("Unauthorized");
            return;
        }
        const event = req.body;
        if (!event || !event.external_id || !event.status) {
            console.warn("Invalid event payload");
            res.status(400).send("Bad Request");
            return;
        }
        const externalId = event.external_id;
        const paymentStatus = event.status;
        // Update Firestore document for the payment
        const paymentDocRef = db.collection("payments").doc(externalId);
        await paymentDocRef.set({
            status: paymentStatus,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            rawEvent: event,
        }, { merge: true });
        // If payment is successful, update locker status and send open command
        if (paymentStatus === "PAID") {
            // Extract lockerId and userId from externalId or event metadata
            // Assuming externalId format: "lockerId_userId_timestamp"
            const parts = externalId.split("_");
            const lockerId = parts[0];
            const userId = parts[1];
            // Update locker document status to 'aktif' and set openCode
            const lockerDocRef = db.collection("lockers").doc(lockerId);
            const openCode = generateOpenCode();
            await lockerDocRef.update({
                status: "aktif",
                userId,
                openCode,
                startTime: admin.firestore.FieldValue.serverTimestamp(),
            });
            // Send open command to ESP32 by updating a Firestore command collection
            const commandDocRef = db.collection("commands").doc(lockerId);
            await commandDocRef.set({
                command: "open",
                openCode,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
            });
            console.log(`Locker ${lockerId} opened for user ${userId} with code ${openCode}`);
        }
        res.status(200).send("OK");
    }
    catch (error) {
        console.error("Error processing Xendit payment callback:", error);
        res.status(500).send("Internal Server Error");
    }
});
// Cloud Function to check payment status
exports.checkPaymentStatus = functions.https.onRequest(async (req, res) => {
    try {
        const { lockerId } = req.query;
        if (!lockerId || typeof lockerId !== "string") {
            res.status(400).json({ error: "Missing or invalid lockerId" });
            return;
        }
        const paymentDoc = await db.collection("payments").doc(lockerId).get();
        if (!paymentDoc.exists) {
            res.status(404).json({ status: "PENDING" });
            return;
        }
        const paymentData = paymentDoc.data();
        if (paymentData?.status === "PAID") {
            res.status(200).json({ status: "PAID" });
        }
        else if (paymentData?.status === "FAILED") {
            res.status(200).json({ status: "FAILED" });
        }
        else {
            res.status(200).json({ status: "PENDING" });
        }
    }
    catch (error) {
        console.error("Error checking payment status:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});
//# sourceMappingURL=index.js.map