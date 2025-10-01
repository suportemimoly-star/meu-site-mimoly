// functions/index.js
const cors = require("cors")({ origin: true });
const { setGlobalOptions } = require("firebase-functions/v2");
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const fetch = require("node-fetch");
const { getAuth } = require("firebase-admin/auth");
const { getStorage } = require("firebase-admin/storage");

// --- CONSTANTES --- 
const REPASSE_PERCENTUAL = 0.50;
const UMA_SEMANA_EM_MS = 7 * 24 * 60 * 60 * 1000;
const ASAAS_FEE = 1.99;
const IMPOSTO_PERCENTUAL = 0.06;
const SAQUE_MINIMO_REAIS = 5.00;
const PACOTES_DE_MIMOS = {
    'pacote_10_mimos': { amount: 10, value: 12.00, description: "Pacote de 10 Mimos" },
    'pacote_50_mimos': { amount: 50, value: 52.00, description: "Pacote de 50 Mimos (Popular)" },
    'pacote_120_mimos': { amount: 120, value: 118.80, description: "Pacote de 120 Mimos" }
};

// --- INICIALIZAÇÃO --- 
setGlobalOptions({ region: "us-central1" });
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

// -------------------------------------------------------------------------------------------
// --- FUNÇÃO PARA CRIAR O PAGAMENTO --- 
// -------------------------------------------------------------------------------------------
exports.createasaaspayment = onRequest({ 
    secrets: ["ASAAS_PROD_KEY"],
    enforceAppCheck: true 
}, (req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') {
            return res.status(405).send({ error: { message: 'Método não permitido.' } });
        }
        if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) {
            return res.status(403).send({ error: { message: 'Requisição não autorizada.' } });
        }
        const idToken = req.headers.authorization.split('Bearer ')[1];
        let decodedToken;
        try {
            decodedToken = await admin.auth().verifyIdToken(idToken);
        } catch (error) {
            return res.status(403).send({ error: { message: 'Token inválido.' } });
        }
        const { uid, email } = decodedToken;
        try {
            const { packageId } = req.body.data;
            const selectedPackage = PACOTES_DE_MIMOS[packageId];
            if (!selectedPackage) {
                return res.status(404).send({ error: { message: 'Pacote não encontrado.' } });
            }
            const userDoc = await db.collection('users').doc(uid).get();
            if (!userDoc.exists) {
                return res.status(404).send({ error: { message: 'Usuário não encontrado.' } });
            }
            const { displayName, cpf } = userDoc.data();
            if (!displayName || !cpf) {
                return res.status(400).send({ error: { message: 'Complete seu perfil com Nome e CPF.' } });
            }
            const asaasApiKey = process.env.ASAAS_PROD_KEY;
            const asaasBaseUrl = 'https://www.asaas.com/api/v3';
            const dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 1);
            const formattedDueDate = dueDate.toISOString().split('T')[0];
            const paymentPayload = {
                billingType: 'PIX', value: selectedPackage.value, dueDate: formattedDueDate, description: selectedPackage.description,
                externalReference: `PAYMENT_${uid}_${packageId}_${Date.now()}`,
                customer: { name: displayName, email: email, cpfCnpj: cpf, externalReference: uid, notificationDisabled: true }
            };
            const createPaymentResponse = await fetch(`${asaasBaseUrl}/payments`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'access_token': asaasApiKey }, body: JSON.stringify(paymentPayload)
            });

            if (!createPaymentResponse.ok) {
                const errorBodyAsText = await createPaymentResponse.text();
                logger.error("!!! RESPOSTA DE ERRO COMPLETA DA ASAAS !!!:", errorBodyAsText);
            }

            const paymentResult = await createPaymentResponse.json();

            if (!createPaymentResponse.ok) {
                logger.error("Erro da API Asaas (Passo 1 - Criação):", paymentResult);
                throw new Error(paymentResult.errors?.[0]?.description || 'Erro ao criar cobrança.');
            }
            const paymentId = paymentResult.id;
            const getQrCodeResponse = await fetch(`${asaasBaseUrl}/payments/${paymentId}/pixQrCode`, {
                method: 'GET', headers: { 'Content-Type': 'application/json', 'access_token': asaasApiKey }
            });
            const qrCodeResult = await getQrCodeResponse.json();
            if (!getQrCodeResponse.ok) {
                logger.error("Erro da API Asaas (Passo 2 - QR Code):", qrCodeResult);
                throw new Error("Pagamento criado, mas falha ao obter o QR Code.");
            }
            await db.collection('transactions').doc(paymentId).set({
                userId: uid, packageId: packageId, status: 'PENDING', value: selectedPackage.value, mimosAmount: selectedPackage.amount,
                asaasPaymentId: paymentId, asaasCustomerId: paymentResult.customer, createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            res.status(200).send({
                data: { id: paymentId, encodedImage: qrCodeResult.encodedImage, payload: qrCodeResult.payload }
            });
        } catch (error) {
            logger.error("Erro interno na função createasaaspayment:", error);
            res.status(500).send({ error: { message: error.message || 'Ocorreu um erro inesperado.' } });
        }
    });
});

// -------------------------------------------------------------------------------------------
// --- FUNÇÃO DE WEBHOOK DO ASAAS --- 
// -------------------------------------------------------------------------------------------
exports.asaasWebhook = onRequest({ secrets: ["ASAAS_WEBHOOK_KEY"] }, (req, res) => {
    cors(req, res, async () => {
        const asaasToken = req.headers['asaas-access-token'];

        if (asaasToken !== process.env.ASAAS_WEBHOOK_KEY) {
            logger.warn("Recebida chamada de webhook com token inválido.");
            return res.status(401).send('Acesso não autorizado');
        }

        const { event, payment } = req.body;
        if (event !== 'PAYMENT_RECEIVED') {
            return res.status(200).send('Evento recebido, mas não processado.');
        }

        try {
            const paymentId = payment.id;
            const transactionRef = db.collection('transactions').doc(paymentId);
            await db.runTransaction(async (t) => {
                const transactionDoc = await t.get(transactionRef);
                if (!transactionDoc.exists || transactionDoc.data().status === 'RECEIVED') {
                    logger.info(`Transação ${paymentId} não encontrada ou já processada.`);
                    return;
                }
                const { userId, mimosAmount } = transactionDoc.data();
                const userRef = db.collection('users').doc(userId);
                t.update(userRef, { saldoMimos: admin.firestore.FieldValue.increment(mimosAmount) });
                t.update(transactionRef, { status: 'RECEIVED', paidAt: admin.firestore.FieldValue.serverTimestamp() });
                logger.info(`Mimos adicionados para o usuário ${userId} via transação ${paymentId}`);
            });
            res.status(200).send('Webhook processado com sucesso');
        } catch (error) {
            logger.error(`Erro ao processar webhook para pagamento ${payment.id}:`, error);
            res.status(500).send('Erro interno no servidor');
        }
    });
});

// -------------------------------------------------------------------------------------------
// --- FUNÇÃO PARA VERIFICAR O STATUS DO PAGAMENTO --- 
// -------------------------------------------------------------------------------------------
exports.checkPaymentStatus = onRequest({ 
    cors: true,
    enforceAppCheck: true 
}, (req, res) => {
    cors(req, res, async () => {
        if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) {
            return res.status(403).json({ error: { message: 'Não autorizado' } });
        }
        try {
            const idToken = req.headers.authorization.split('Bearer ')[1];
            await admin.auth().verifyIdToken(idToken);
            const { paymentId } = req.body.data;
            if (!paymentId) {
                return res.status(400).json({ error: { message: 'paymentId não fornecido' } });
            }
            const transactionRef = db.collection('transactions').doc(paymentId);
            const doc = await transactionRef.get();
            if (!doc.exists) {
                return res.status(404).json({ data: { status: 'NOT_FOUND' } });
            }
            res.status(200).json({ data: { status: doc.data().status } });
        } catch (error) {
            logger.error("Erro em checkPaymentStatus:", error);
            res.status(500).json({ error: { message: 'Erro interno' } });
        }
    });
});

// -------------------------------------------------------------------------------------------
// --- FUNÇÃO DE CHAT - INICIAR ---
// -------------------------------------------------------------------------------------------
exports.initiateChat = onCall({ enforceAppCheck: true }, async (request) => { 
    if (!request.auth) throw new HttpsError("unauthenticated", "Você precisa estar logado.");
    
    const senderId = request.auth.uid;
    const { targetUserId } = request.data;
    if (!targetUserId) throw new HttpsError("invalid-argument", "Falta o ID do destinatário.");
    const senderRef = db.collection("users").doc(senderId);
    const chatId = [senderId, targetUserId].sort().join('_');
    const now = admin.firestore.Timestamp.now();
    const senderDoc = await senderRef.get();
    if (!senderDoc.exists) throw new HttpsError("not-found", "Seu perfil de usuário não foi encontrado.");
    const senderData = senderDoc.data();
    const oneWeekAgo = admin.firestore.Timestamp.fromMillis(now.toMillis() - UMA_SEMANA_EM_MS);
    let isFreeChat = !senderData.lastFreeChatDate || senderData.lastFreeChatDate < oneWeekAgo;
    if (!isFreeChat && (!senderData.saldoMimos || senderData.saldoMimos < 1)) {
        throw new HttpsError("failed-precondition", "Você não tem Mimos suficientes para iniciar uma nova conversa.");
    }
    await db.runTransaction(async (transaction) => {
        if (isFreeChat) transaction.update(senderRef, { lastFreeChatDate: now });
        const chatRef = db.collection("chats").doc(chatId);
        transaction.set(chatRef, {
            participants: [senderId, targetUserId], initiatorId: senderId, status: 'pending_response',
            createdAt: now, updatedAt: now, isFreeChat: isFreeChat, lastMessage: null
        }, { merge: true });
    });
    return { success: true, chatId: chatId };
});

// -------------------------------------------------------------------------------------------
// --- FUNÇÃO DE CHAT - PRIMEIRA RESPOSTA (COM VERIFICAÇÃO DE SALDO) ---
// -------------------------------------------------------------------------------------------
exports.processFirstReply = onDocumentUpdated('chats/{chatId}', async (event) => {
    const beforeData = event.data.before.data();
    const afterData = event.data.after.data();
    const chatRef = event.data.after.ref;

    if (beforeData.status !== 'pending_response' || afterData.status !== 'active') {
        return null;
    }

    if (afterData.isFreeChat) {
        logger.info(`Primeira resposta em chat grátis (${event.params.chatId}). Nenhum Mimo descontado.`);
        const now = admin.firestore.Timestamp.now();
        const newAccessExpiresAt = admin.firestore.Timestamp.fromMillis(now.toMillis() + UMA_SEMANA_EM_MS);
        await chatRef.update({ accessExpiresAt: newAccessExpiresAt });
        return null;
    }

    const { initiatorId, participants } = afterData;
    const receiverId = participants.find(id => id !== initiatorId);
    if (!receiverId) {
        logger.error(`Não foi possível encontrar o receiverId para o chat ${event.params.chatId}`);
        return null;
    }

    const initiatorRef = db.collection('users').doc(initiatorId);
    const receiverRef = db.collection('users').doc(receiverId);

    try {
        const initiatorDocForName = await initiatorRef.get();
        const initiatorName = initiatorDocForName.data()?.displayName || 'um usuário';

        const transactionsRef = db.collection('transactions');
        const lastPurchaseSnapshot = await transactionsRef.where('userId', '==', initiatorId).where('status', '==', 'RECEIVED').orderBy('createdAt', 'desc').limit(1).get();
        let packageData;
        if (!lastPurchaseSnapshot.empty) {
            const lastPurchase = lastPurchaseSnapshot.docs[0].data();
            packageData = PACOTES_DE_MIMOS[lastPurchase.packageId];
        } else {
            packageData = PACOTES_DE_MIMOS['pacote_120_mimos'];
        }
        const valorBrutoPacote = packageData.value;
        const mimosNoPacote = packageData.amount;
        const valorAposTaxaAsaas = valorBrutoPacote - 1.99;
        const valorAposImposto = valorAposTaxaAsaas * (1 - 0.06);
        const valorLiquidoPorMimo = valorAposImposto / mimosNoPacote;
        const valorRepasseCalculado = valorLiquidoPorMimo * 0.50;
        
        await db.runTransaction(async (t) => {
            const initiatorDoc = await t.get(initiatorRef);
            if (!initiatorDoc.exists) {
                throw new Error(`Usuário iniciador ${initiatorId} não encontrado.`);
            }
            const initiatorData = initiatorDoc.data();

            if (!initiatorData.saldoMimos || initiatorData.saldoMimos < 1) {
                throw new Error(`Saldo de Mimos insuficiente para o usuário ${initiatorId}.`);
            }

            const now = admin.firestore.Timestamp.now();
            const newAccessExpiresAt = admin.firestore.Timestamp.fromMillis(now.toMillis() + UMA_SEMANA_EM_MS);
            const receiverTransactionsRef = receiverRef.collection("walletTransactions").doc();

            t.update(initiatorRef, { saldoMimos: admin.firestore.FieldValue.increment(-1) });
            t.update(receiverRef, { saldoReais: admin.firestore.FieldValue.increment(valorRepasseCalculado) });
            t.set(receiverTransactionsRef, {
                type: 'CREDIT', amount: valorRepasseCalculado, description: `Recebido de ${initiatorName}`,
                status: 'COMPLETED', createdAt: now, chatId: event.params.chatId
            });
            t.update(chatRef, { accessExpiresAt: newAccessExpiresAt });
        });

        const now = admin.firestore.Timestamp.now();
        const valorRepasseFormatado = valorRepasseCalculado.toFixed(2).replace('.', ',');
        const systemMessageReceiver = { text: `Sua resposta rendeu R$ ${valorRepasseFormatado}!`, senderId: 'system_receiver', timestamp: now };
        const systemMessageInitiator = { text: "Sua resposta foi recebida! 1 Mimo foi utilizado e seu saldo foi atualizado.", senderId: "system_initiator", timestamp: now };
        
        const messagesRef = chatRef.collection("messages");
        const batch = db.batch();
        batch.create(messagesRef.doc(), systemMessageReceiver);
        batch.create(messagesRef.doc(), systemMessageInitiator);
        await batch.commit();

        logger.info(`Processo de primeira resposta concluído para o chat ${event.params.chatId}. Repasse de R$${valorRepasseCalculado.toFixed(2)}.`);

    } catch (error) {
        logger.error(`Falha na transação da primeira resposta para o chat ${event.params.chatId}:`, error.message);

        const now = admin.firestore.Timestamp.now();
        const failMessageReceiver = { text: `O Mimo do outro usuário não pôde ser processado. Nenhum valor foi adicionado à sua carteira para esta resposta.`, senderId: 'system_receiver', timestamp: now };
        const failMessageInitiator = { text: `Não foi possível usar seu Mimo para esta resposta (saldo insuficiente no momento). A conversa foi liberada, mas nenhum Mimo foi descontado.`, senderId: 'system_initiator', timestamp: now };
        
        const messagesRef = chatRef.collection("messages");
        const batch = db.batch();
        batch.create(messagesRef.doc(), failMessageReceiver);
        batch.create(messagesRef.doc(), failMessageInitiator);
        
        const newAccessExpiresAt = admin.firestore.Timestamp.fromMillis(now.toMillis() + UMA_SEMANA_EM_MS);
        batch.update(chatRef, { accessExpiresAt: newAccessExpiresAt });
        await batch.commit();
    }

    return null;
});

// -------------------------------------------------------------------------------------------
// --- FUNÇÃO DE CHAT - ENVIAR MENSAGEM --- 
// -------------------------------------------------------------------------------------------
exports.sendMessage = onCall({ enforceAppCheck: true }, async (request) => { 
    if (!request.auth) throw new HttpsError("unauthenticated", "Você precisa estar logado.");
    
    const senderId = request.auth.uid;
    const { chatId, text } = request.data;
    if (!chatId || !text) throw new HttpsError("invalid-argument", "Faltam parâmetros (chatId, text).");

    const chatRef = db.collection("chats").doc(chatId);
    const messagesRef = chatRef.collection("messages"); 
    const now = admin.firestore.Timestamp.now();
    const newMessage = { text, timestamp: now, senderId };
    
    const chatDoc = await chatRef.get();
    if (!chatDoc.exists) throw new HttpsError("not-found", "Chat não encontrado.");
    const chatData = chatDoc.data();
    
    if (chatData.status === 'active' && chatData.accessExpiresAt && chatData.accessExpiresAt < now) {
        if (senderId !== chatData.initiatorId) {
            throw new HttpsError("permission-denied", "Apenas quem iniciou a conversa pode reativá-la com um Mimo.");
        }
        const initiatorRef = db.collection("users").doc(senderId);
        const receiverId = chatData.participants.find(p => p !== senderId);
        const receiverRef = db.collection("users").doc(receiverId);
        
        try {
            const transactionsRef = db.collection('transactions');
            const lastPurchaseSnapshot = await transactionsRef.where('userId', '==', senderId).where('status', '==', 'RECEIVED').orderBy('createdAt', 'desc').limit(1).get();
            let packageData;
            if (!lastPurchaseSnapshot.empty) {
                const lastPurchase = lastPurchaseSnapshot.docs[0].data();
                packageData = PACOTES_DE_MIMOS[lastPurchase.packageId];
            } else {
                packageData = PACOTES_DE_MIMOS['pacote_120_mimos'];
            }
            const valorBrutoPacote = packageData.value;
            const mimosNoPacote = packageData.amount;
            const valorAposTaxaAsaas = valorBrutoPacote - 1.99;
            const valorAposImposto = valorAposTaxaAsaas * (1 - 0.06);
            const valorLiquidoPorMimo = valorAposImposto / mimosNoPacote;
            const valorRepasseCalculado = valorLiquidoPorMimo * 0.50;

            await db.runTransaction(async (transaction) => {
                const initiatorDoc = await transaction.get(initiatorRef);
                if (!initiatorDoc.exists || initiatorDoc.data().saldoMimos < 1) {
                    throw new Error("Saldo de Mimos insuficiente para continuar a conversa.");
                }
                transaction.update(initiatorRef, { saldoMimos: admin.firestore.FieldValue.increment(-1) });
                transaction.update(receiverRef, { saldoReais: admin.firestore.FieldValue.increment(valorRepasseCalculado) });
                
                const newAccessExpiresAt = admin.firestore.Timestamp.fromMillis(now.toMillis() + UMA_SEMANA_EM_MS);
                transaction.update(chatRef, { accessExpiresAt: newAccessExpiresAt, updatedAt: now });
            });
            
            const valorRepasseFormatado = valorRepasseCalculado.toFixed(2).replace('.', ',');
            const receiverMessage = { text: `A conversa foi reativada! Você recebeu R$ ${valorRepasseFormatado}`, senderId: "system_receiver", timestamp: now };
            const initiatorMessage = { text: "Conversa reativada por 7 dias. 1 Mimo foi utilizado.", senderId: "system_initiator", timestamp: now };
            
            const batch = db.batch();
            batch.create(messagesRef.doc(), newMessage); 
            batch.create(messagesRef.doc(), receiverMessage); 
            batch.create(messagesRef.doc(), initiatorMessage); 
            batch.update(chatRef, { lastMessage: newMessage }); 
            await batch.commit();

            logger.info(`Chat ${chatId} reativado com sucesso com cálculo dinâmico.`);
            return { success: true };
        } catch (error) {
            logger.error(`Erro ao reativar chat ${chatId} com cálculo dinâmico:`, error);
            throw new HttpsError("failed-precondition", error.message);
        }
    } else {
        const batch = db.batch();
        
        batch.create(messagesRef.doc(), newMessage);

        const updateData = { lastMessage: newMessage, updatedAt: now };
        if (chatData.status === 'pending_response' && senderId !== chatData.initiatorId) {
            updateData.status = 'active'; 
        }
        batch.update(chatRef, updateData);
        
        await batch.commit(); 
        return { success: true };
    }
});


// -------------------------------------------------------------------------------------------
// --- FUNÇÕES DE CONTADOR DE MENSAGENS NÃO LIDAS --- 
// -------------------------------------------------------------------------------------------
exports.incrementUnreadCountOnNewMessage = onDocumentUpdated("chats/{chatId}", async (event) => {
    const afterData = event.data.after.data();
    const beforeData = event.data.before.data();

    if (!afterData.lastMessage || beforeData.lastMessage?.timestamp === afterData.lastMessage?.timestamp) {
        return null;
    }

    const lastMessage = afterData.lastMessage;
    const senderId = lastMessage.senderId;
    const recipientId = afterData.participants.find((id) => id !== senderId);

    if (!recipientId) {
        logger.error(`Não foi possível encontrar o destinatário para o chat ${event.params.chatId}`);
        return null;
    }

    const recipientRef = db.doc(`users/${recipientId}`);
    const updatePath = `unreadChats.${event.params.chatId}`;
    
    logger.info(`Incrementando contador para o usuário: ${recipientId} no chat ${event.params.chatId}`);
    return recipientRef.update({
        [updatePath]: admin.firestore.FieldValue.increment(1),
    });
});

exports.markChatAsRead = onCall({ enforceAppCheck: true }, async (request) => { 
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Você precisa estar logado.");
  }
  
  const uid = request.auth.uid;
  const { chatId } = request.data;
  if (!chatId) {
     throw new HttpsError("invalid-argument", "O ID do chat é necessário.");
  }
  const userRef = db.collection("users").doc(uid);
  try {
    const updatePath = `unreadChats.${chatId}`;
    await userRef.update({
      [updatePath]: admin.firestore.FieldValue.delete(),
    });
    logger.info(`Chat ${chatId} marcado como lido para o usuário: ${uid}`);
    return { success: true };
  } catch (error) {
    logger.error(`Erro ao marcar chat ${chatId} como lido:`, error);
    throw new HttpsError("internal", "Ocorreu um erro ao marcar o chat como lido.");
  }
});

// -------------------------------------------------------------------------------------------
// --- FUNÇÃO PARA CURTIR/DESCURTIR UM PERFIL --- 
// -------------------------------------------------------------------------------------------
exports.toggleLike = onCall({ enforceAppCheck: true }, async (request) => { 
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "Você precisa estar logado.");
    }
    
    const senderId = request.auth.uid;
    const { targetUserId } = request.data;
    if (!targetUserId || senderId === targetUserId) {
        throw new HttpsError("invalid-argument", "ID de usuário alvo inválido.");
    }
    const senderRef = db.doc(`users/${senderId}`);
    const targetRef = db.doc(`users/${targetUserId}`);
    const likeRef = db.doc(`users/${targetUserId}/likesReceived/${senderId}`);
    try {
        const likeDoc = await likeRef.get();
        if (likeDoc.exists) {
            await db.runTransaction(async (t) => {
                const targetDoc = await t.get(targetRef);
                const currentLikes = targetDoc.data()?.newLikesCount || 0;
                t.delete(likeRef);
                t.update(senderRef, {
                    perfisCurtidos: admin.firestore.FieldValue.arrayRemove(targetUserId)
                });
                if (currentLikes > 0) {
                    t.update(targetRef, {
                        newLikesCount: admin.firestore.FieldValue.increment(-1)
                    });
                }
            });
            logger.info(`Usuário ${senderId} descurtiu ${targetUserId} (transacional)`);
            return { success: true, liked: false };
        } else {
            const senderDoc = await senderRef.get();
            if (!senderDoc.exists) {
                throw new HttpsError("not-found", "Seu perfil não foi encontrado.");
            }
            const senderData = senderDoc.data();
            await likeRef.set({
                likedAt: admin.firestore.FieldValue.serverTimestamp(),
                senderDisplayName: senderData.displayName || '',
                senderPhotoURL: senderData.photoURL || 'https://t4.ftcdn.net/jpg/05/49/98/39/360_F_549983970_bRCkYfk0P6PP5fKbMhZMIb07LwqYdTyH.jpg',
                senderIdade: senderData.idade || '',
                senderCidade: senderData.cidade || '',
                senderEstado: senderData.estado || ''
            });
            await senderRef.update({
                perfisCurtidos: admin.firestore.FieldValue.arrayUnion(targetUserId)
            });
            await targetRef.update({
                newLikesCount: admin.firestore.FieldValue.increment(1)
            });
            logger.info(`Usuário ${senderId} curtiu ${targetUserId}`);
            return { success: true, liked: true };
        }
    } catch (error) {
        logger.error(`Erro ao processar like de ${senderId} para ${targetUserId}:`, error);
        throw new HttpsError("internal", "Ocorreu um erro ao processar a curtida.");
    }
});

// -------------------------------------------------------------------------------------------
// --- FUNÇÃO PARA DELETAR CONTA --- 
// -------------------------------------------------------------------------------------------
exports.deleteUserAccount = onRequest({
    secrets: ["ASAAS_PROD_KEY"], // Mantém o acesso a secrets se necessário no futuro
    enforceAppCheck: true 
}, (req, res) => {
    cors(req, res, async () => {
        // Verifica o método da requisição
        if (req.method !== 'POST') {
            return res.status(405).send({ error: { message: 'Método não permitido.' } });
        }

        // Verifica o token de autenticação
        if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) {
            return res.status(403).send({ error: { message: 'Requisição não autorizada.' } });
        }
        
        const idToken = req.headers.authorization.split('Bearer ')[1];
        let decodedToken;
        try {
            decodedToken = await admin.auth().verifyIdToken(idToken);
        } catch (error) {
            return res.status(403).send({ error: { message: 'Token inválido.' } });
        }
        
        const uid = decodedToken.uid;
        if (!uid) {
            return res.status(403).send({ error: { message: 'UID do usuário não encontrado no token.' } });
        }

        const { forceDelete } = req.body.data;
        const userDocRef = db.collection("users").doc(uid);
        
        try {
            const userDoc = await userDocRef.get();
            if (!userDoc.exists) {
                await getAuth().deleteUser(uid).catch(e => logger.warn(`Auth user ${uid} já não existia.`));
                return res.status(200).send({ data: { success: true } });
            }

            const userData = userDoc.data();
            const saldoReais = userData.saldoReais || 0;

            if (saldoReais >= 5.00) {
                return res.status(412).send({ data: {
                    success: false,
                    code: 'MUST_WITHDRAW_FIRST',
                    message: 'Você possui um saldo igual ou superior a R$ 5,00. Por favor, solicite o saque antes de excluir sua conta.'
                }});
            }

            if (saldoReais > 0 && saldoReais < 5.00 && !forceDelete) {
                return res.status(412).send({ data: {
                    success: false,
                    code: 'HAS_BALANCE_BELOW_MINIMUM',
                    message: `Você possui um saldo de R$ ${saldoReais.toFixed(2).replace('.', ',')} que é inferior ao mínimo para saque. Ao excluir a conta, este valor será perdido. Deseja continuar?`
                }});
            }

            // --- ETAPAS DE EXCLUSÃO COMPLETA ---
            await getAuth().deleteUser(uid);
            logger.info(`Usuário ${uid} excluído do Authentication.`);

            const bucket = getStorage().bucket();
            const folderPath = `profile-pictures/${uid}/`;
            await bucket.deleteFiles({ prefix: folderPath });
            logger.info(`Arquivos do usuário ${uid} excluídos do Storage.`);

            await userDocRef.delete();
            logger.info(`Documento do usuário ${uid} excluído do Firestore.`);

            return res.status(200).send({ data: { success: true, message: "Conta excluída com sucesso." } });

        } catch (error) {
            logger.error(`Erro ao excluir conta completa do usuário ${uid}:`, error);
            return res.status(500).send({ error: { message: 'Ocorreu um erro ao excluir sua conta.' } });
        }
    });
});

// -------------------------------------------------------------------------------------------
// --- FUNÇÃO PARA SOLICITAR SAQUE --- 
// -------------------------------------------------------------------------------------------
function getPixKeyType(key) {
    const cleanKey = String(key).replace(/[^\w@+]/g, '');
    if (/^\d{11}$/.test(cleanKey)) return 'CPF';
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) return 'EMAIL';
    if (/^\+?55\d{10,11}$/.test(cleanKey)) return 'PHONE';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) return 'EVP';
    return null;
}

exports.testSecretAccess = onCall({ 
    secrets: ["ASAAS_PROD_KEY"],
    enforceAppCheck: true 
}, (request) => {
    logger.info("Iniciando o teste de acesso ao segredo...");
    
    const asaasApiKey = process.env.ASAAS_PROD_KEY;
    if (asaasApiKey && asaasApiKey.length > 1) {
        logger.info("SUCESSO: O segredo ASAAS_PROD_KEY foi lido com sucesso.");
        logger.info(`Valor parcial da chave: ${asaasApiKey.substring(0, 10)}...`);
        return { success: true, message: "Segredo lido com sucesso!" };
    } else {
        logger.error("FALHA: O segredo ASAAS_PROD_KEY está undefined ou vazio dentro da função.");
        return { success: false, message: "FALHA ao ler o segredo. Verifique os logs." };
    }
});

exports.requestWithdrawal = onCall({ 
    secrets: ["ASAAS_PROD_KEY"],
    enforceAppCheck: true 
}, async (request) => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Você precisa estar logado para solicitar um saque.');
    }
    
    const uid = request.auth.uid;
    const userRef = db.collection('users').doc(uid);
    try {
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            throw new HttpsError('not-found', 'Usuário não encontrado.');
        }
        const userData = userDoc.data();
        const saldoAtual = userData.saldoReais || 0;
        const chavePix = userData.pixKey;
        if (!chavePix) {
            throw new HttpsError('failed-precondition', 'Você precisa cadastrar uma chave PIX antes de sacar.');
        }
        if (saldoAtual < SAQUE_MINIMO_REAIS) {
            throw new HttpsError('failed-precondition', `Seu saldo de R$ ${saldoAtual.toFixed(2).replace('.',',')} é insuficiente para sacar. O mínimo é R$ ${SAQUE_MINIMO_REAIS.toFixed(2).replace('.',',')}.`);
        }
        const asaasApiKey = process.env.ASAAS_PROD_KEY;
        const asaasBaseUrl = 'https://www.asaas.com/api/v3';
        const transferPayload = {
            value: saldoAtual,
            pixAddressKey: chavePix,
            pixAddressKeyType: getPixKeyType(chavePix) || 'EVP',
            description: `Saque de saldo Mimoly (Usuário: ${uid})`,
        };
        const createTransferResponse = await fetch(`${asaasBaseUrl}/transfers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'access_token': asaasApiKey },
            body: JSON.stringify(transferPayload)
        });
        const transferResult = await createTransferResponse.json();
        if (!createTransferResponse.ok) {
            logger.error("Erro da API Asaas ao tentar criar transferência:", transferResult);
            const errorMessage = transferResult.errors?.[0]?.description || 'Erro ao comunicar com o processador de pagamento.';
            throw new HttpsError('internal', errorMessage);
        }
        const transferId = transferResult.id;
        const now = admin.firestore.Timestamp.now();
        const withdrawalRef = userRef.collection("walletTransactions").doc();
        await db.runTransaction(async (t) => {
            t.update(userRef, { saldoReais: admin.firestore.FieldValue.increment(-saldoAtual) });
            t.set(withdrawalRef, {
                type: 'DEBIT',
                amount: -saldoAtual,
                description: 'Saque solicitado via PIX',
                status: 'PROCESSING',
                createdAt: now,
                asaasTransferId: transferId
            });
        });
        return { success: true, message: "Saque solicitado com sucesso! O valor será transferido em breve." };
    } catch (error) {
        logger.error(`Erro na função requestWithdrawal para o usuário ${uid}:`, error);
        if (error instanceof HttpsError) {
            throw error;
        }
        throw new HttpsError('internal', 'Ocorreu um erro inesperado ao processar seu saque.');
    }
});

// -------------------------------------------------------------------------------------------
// --- FUNÇÃO PARA BUSCAR O EXTRATO DA CARTEIRA --- 
// -------------------------------------------------------------------------------------------
exports.getWalletStatement = onCall({ enforceAppCheck: true }, async (request) => { 
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Você precisa estar logado para ver o extrato.');
    }
    
    const uid = request.auth.uid;
    const userRef = db.collection('users').doc(uid);
    try {
        const transactionsRef = userRef.collection('walletTransactions');
        const snapshot = await transactionsRef.orderBy('createdAt', 'desc').limit(50).get();
        if (snapshot.empty) {
            return { transactions: [] };
        }
        const transactions = snapshot.docs.map(doc => {
            const data = doc.data();
            return {
                ...data,
                createdAt: data.createdAt.toDate().toISOString()
            };
        });
        return { transactions: transactions };
    } catch (error) {
        logger.error(`Erro ao buscar extrato para o usuário ${uid}:`, error);
        throw new HttpsError('internal', 'Não foi possível buscar seu extrato no momento.');
    }
});