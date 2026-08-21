import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

let auth = null;

function ensureInitialized() {
  if (auth) return auth;

  // Two supported ways to provide the service account, so this works both
  // locally (a JSON key file) and on hosts where you can only set env vars
  // (paste the whole JSON into FIREBASE_SERVICE_ACCOUNT_JSON).
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    credential = cert(parsed);
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    credential = cert(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
  } else {
    throw new Error(
      "Firebase Admin isn't configured. Set FIREBASE_SERVICE_ACCOUNT_PATH (path to a service account " +
        "JSON file) or FIREBASE_SERVICE_ACCOUNT_JSON (the JSON itself) in backend/.env. " +
        "Get one from Firebase Console > Project Settings > Service Accounts > Generate new private key."
    );
  }

  const app = initializeApp({ credential });
  auth = getAuth(app);
  return auth;
}

/** Shared Firebase Admin Auth instance for server-side account updates. */
export function getFirebaseAuth() {
  return ensureInitialized();
}

/**
 * Express middleware: requires a valid Firebase ID token in the
 * `Authorization: Bearer <token>` header, and sets req.uid on success.
 * Responds 401 if missing/invalid.
 */
export function requireAuth(req, res, next) {
  let authInstance;
  try {
    authInstance = ensureInitialized();
  } catch (err) {
    res.status(500).json({ error: err.message });
    return;
  }

  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Missing or malformed Authorization header." });
  }

  authInstance
    .verifyIdToken(token)
    .then((decoded) => {
      req.uid = decoded.uid;
      req.userEmail = decoded.email;
      req.auth = decoded;
      next();
    })
    .catch((err) => {
      res.status(401).json({ error: `Invalid or expired auth token: ${err.message}` });
    });
}
