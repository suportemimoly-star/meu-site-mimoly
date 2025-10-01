// firebase-config.js - ÚNICA FONTE DE CONFIGURAÇÃO

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-storage.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js";

import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app-check.js";

const firebaseConfig = {
    apiKey: "AIzaSyCQQPZuAiVOS39ZHHnY-bej7JA4n3Vwi7s",
    authDomain: "sitemimoly.firebaseapp.com",
    projectId: "sitemimoly",
    storageBucket: "sitemimoly.firebasestorage.app",
    messagingSenderId: "72311853993",
    appId: "1:72311853993:web:17162fc27ba0ab0f406ab8"
};

const app = initializeApp(firebaseConfig);

const appCheck = initializeAppCheck(app, {
  provider: new ReCaptchaV3Provider('6Lf3EdcrAAAAAB3gfwxQ6A5zYoxjKMVr6EC27-R1'),
  isTokenAutoRefreshEnabled: true
});

const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const functions = getFunctions(app, 'us-central1');

export { auth, db, storage, functions };