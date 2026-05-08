// firebase.js
import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

/**
 * Configuration Firebase
 */
const firebaseConfig = {
  apiKey: "AIzaSyBrxMSW0cXl-2YbRYOdgAFnARMDj5TRNdU",
  authDomain: "mototrackweb.firebaseapp.com",
  projectId: "mototrackweb",
  storageBucket: "mototrackweb.appspot.com",
  messagingSenderId: "758361184331",
  appId: "1:758361184331:web:1586d872d5e8d5979c95ce",
};

/**
 * ✅ Évite la double initialisation (important en dev / Expo)
 */
const app = getApps().length === 0
  ? initializeApp(firebaseConfig)
  : getApp();

/**
 * Services Firebase
 */
export const db = getFirestore(app);
export const auth = getAuth(app);
