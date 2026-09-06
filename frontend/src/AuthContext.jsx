import { createContext, useContext, useEffect, useState } from "react";
import {
  getAdditionalUserInfo,
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
} from "firebase/auth";
import { auth, googleProvider } from "./firebase.js";
import { trackEvent } from "./analytics.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = still checking, null = signed out
  const [error, setError] = useState(null);

  useEffect(() => {
    return onAuthStateChanged(auth, (u) => setUser(u));
  }, []);

  async function signInWithGoogle() {
    setError(null);
    try {
      const credential = await signInWithPopup(auth, googleProvider);
      // One Google button serves both cases, so ask Firebase which it was
      // rather than reporting every account creation as a returning login.
      const isNewUser = getAdditionalUserInfo(credential)?.isNewUser === true;
      trackEvent(isNewUser ? "sign_up" : "login", { method: "google" });
    } catch (e) {
      setError(friendlyAuthError(e));
      throw e;
    }
  }

  async function signInWithEmail(email, password) {
    setError(null);
    try {
      await signInWithEmailAndPassword(auth, email, password);
      trackEvent("login", { method: "password" });
    } catch (e) {
      setError(friendlyAuthError(e));
      throw e;
    }
  }

  async function signUpWithEmail(email, password) {
    setError(null);
    try {
      await createUserWithEmailAndPassword(auth, email, password);
      trackEvent("sign_up", { method: "password" });
    } catch (e) {
      setError(friendlyAuthError(e));
      throw e;
    }
  }

  async function signOut() {
    await firebaseSignOut(auth);
  }

  /** ID token to attach to backend API requests (Authorization: Bearer <token>). */
  async function getIdToken() {
    if (!auth.currentUser) return null;
    return auth.currentUser.getIdToken();
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        loading: user === undefined,
        error,
        clearError: () => setError(null),
        signInWithGoogle,
        signInWithEmail,
        signUpWithEmail,
        signOut,
        getIdToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside an AuthProvider");
  return ctx;
}

function friendlyAuthError(e) {
  const code = e?.code || "";
  const map = {
    "auth/invalid-email": "That doesn't look like a valid email address.",
    "auth/user-not-found": "No account found with that email.",
    "auth/wrong-password": "Incorrect password.",
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/email-already-in-use": "An account with that email already exists — try signing in instead.",
    "auth/weak-password": "Password should be at least 6 characters.",
    "auth/popup-closed-by-user": "Sign-in was cancelled.",
    "auth/network-request-failed": "Network error — check your connection and try again.",
  };
  return map[code] || e?.message || "Something went wrong signing in.";
}
