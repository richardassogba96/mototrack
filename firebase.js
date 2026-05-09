// firebase.js
import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

/**
 * Configuration Firebase
 */
const firebaseConfig = {
  apiKey: "AIzaSyAQSG7KAndEVAK_ullNM7B4ohV6VoOPB3Q",
  authDomain: "mototrack-a40ec.firebaseapp.com",
  projectId: "mototrack-a40ec",
  storageBucket: "mototrack-a40ec.firebasestorage.app",
  messagingSenderId: "943332422322",
  appId: "1:943332422322:web:d4243def49b3c93ec38fab",
  measurementId: "G-WR8YVG4WTF"
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
