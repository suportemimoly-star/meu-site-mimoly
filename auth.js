// auth.js - Funções auxiliares (Callables)

import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js";
// Importa o 'auth' e 'functions' da nossa fonte central
import { auth, functions } from './firebase-config.js';

const initiateChatFunction = httpsCallable(functions, 'initiateChat');
const sendMessageFunction = httpsCallable(functions, 'sendMessage');
const markChatAsReadFunction = httpsCallable(functions, 'markChatAsRead');


export async function callInitiateChatSafely(targetUserId) {
  if (!auth.currentUser) throw new Error("Usuário não autenticado.");
  try {
    const result = await initiateChatFunction({ targetUserId });
    return result.data;
  } catch (error) {
    console.error('❌ Erro ao chamar "initiateChat":', error);
    throw error;
  }
}

export async function callSendMessageSafely(chatId, text) {
  if (!auth.currentUser) throw new Error("Usuário não autenticado.");
  try {
    const result = await sendMessageFunction({ chatId, text });
    return result.data;
  } catch (error) {
    console.error('❌ Erro ao chamar "sendMessage":', error);
    throw error;
  }
}

export async function callMarkChatAsReadSafely(chatId) {
  if (!auth.currentUser || !chatId) return;
  try {
    await markChatAsReadFunction({ chatId: chatId });
    console.log(`Chat ${chatId} marcado como lido.`);
  } catch (error) {
    console.error(`❌ Erro ao chamar "markChatAsRead" para o chat ${chatId}:`, error);
  }
}