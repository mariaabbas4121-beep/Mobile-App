import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyA0HAh_o_x_bFfBEqqEOVmI9Ppf3ikc1eg",
  authDomain: "neighborshare-12345.firebaseapp.com",
  projectId: "neighborshare-12345",
  storageBucket: "neighborshare-12345.firebasestorage.app",
  messagingSenderId: "230099305907",
  appId: "1:230099305907:web:d5a0c76a872f5ac117f7c6",
  measurementId: "G-WF99KS358T"
};
// Initialize Firebase
const app = initializeApp(firebaseConfig);

// 🔐 Authentication service
export const auth = getAuth(app);

// 🗄️ Database service
export const db = getFirestore(app);