// header-loader.js
import { auth, db } from './firebase-config.js';
import { signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

let unsubscribeUserListener = null;

export async function loadHeader() {
    const headerPlaceholder = document.querySelector('header');
    if (!headerPlaceholder) return;
    try {
        const response = await fetch('/_header.html');
        if (!response.ok) throw new Error(`Falha ao buscar _header.html`);
        headerPlaceholder.innerHTML = await response.text();
        lucide.createIcons();
        const filterButton = document.getElementById('open-filter-modal-btn');
        const currentPage = window.location.pathname.split('/').pop();
        if (filterButton && currentPage !== 'app.html') {
            filterButton.style.display = 'none';
        }
        initializeHeaderLogic();
        highlightActiveNavLink();
    } catch (error) {
        console.error("Erro ao carregar o header:", error);
    }
}

function initializeHeaderLogic() {
    const userPhotoHeader = document.getElementById('user-photo-header');
    const userDropdown = document.getElementById('user-dropdown');
    const userMenu = document.getElementById('user-menu');
    const logoutBtn = document.getElementById('logout-btn');
    const logoutBtnMobile = document.getElementById('logout-btn-mobile');
    const mobileMenuButton = document.getElementById('mobile-menu-button');
    const mobileMenu = document.getElementById('mobile-menu');
    let isDropdownOpen = false;
    let isMobileMenuOpen = false;

    if (userPhotoHeader) {
        userPhotoHeader.addEventListener('click', (event) => {
            event.stopPropagation();
            isDropdownOpen = !isDropdownOpen;
            userDropdown.style.display = isDropdownOpen ? 'block' : 'none';
        });

        document.addEventListener('click', (event) => {
            if (isDropdownOpen && !userDropdown.contains(event.target) && event.target !== userPhotoHeader) {
                userDropdown.style.display = 'none';
                isDropdownOpen = false;
            }
        });
    }

    if (mobileMenuButton) {
        mobileMenuButton.addEventListener('click', () => {
            isMobileMenuOpen = !isMobileMenuOpen;
            mobileMenu.classList.toggle('hidden');
        });
    }

    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => { await signOut(auth); });
    }
    if (logoutBtnMobile) {
        logoutBtnMobile.addEventListener('click', async () => { await signOut(auth); });
    }

    onAuthStateChanged(auth, async (user) => {
        if (unsubscribeUserListener) unsubscribeUserListener();

        if (user) {
            unsubscribeUserListener = onSnapshot(doc(db, "users", user.uid), (userDoc) => {
                if (userDoc.exists() && userMenu) {
                    const userData = userDoc.data();
                    const currentPage = window.location.pathname;
                    
                    function isProfileComplete(data) {
                         return data.displayName && data.photoURL && data.cpf && data.idade && data.sexo && data.cidade && data.estado && data.bio;                          
                    }           


                    if (!isProfileComplete(userData) && currentPage !== '/perfil.html') {
                            window.location.href = '/perfil.html?msg=complete-profile';
                            return; // Para a execução do restante do código para evitar erros
                    }

                    document.getElementById('user-name-header').textContent = userData.displayName || 'Usuário';
                    document.getElementById('user-photo-header').src = userData.photoURL || 'https://t4.ftcdn.net/jpg/05/49/98/39/360_F_549983970_bRCkYfk0P6PP5fKbMhZMIb07LwqYdTyH.jpg';
                    document.getElementById('user-mimos-balance').textContent = userData.saldoMimos || 0;
                    userMenu.classList.remove('hidden');
                    userMenu.classList.add('flex');
                    
                    // --- INÍCIO DA LÓGICA DE NOTIFICAÇÃO UNIFICADA E DINÂMICA ---

                    const newLikesCount = userData.newLikesCount || 0;
                    const unreadChatsMap = userData.unreadChats || {};
                    const unreadMessageCount = Object.values(unreadChatsMap).reduce((sum, count) => sum + count, 0);
                    const totalNotifications = newLikesCount + unreadMessageCount;

                    const newLikesDesktopEl = document.getElementById('new-likes-count-desktop');
                    const newLikesMobileEl = document.getElementById('new-likes-count-mobile');
                    const unreadCountDesktopEl = document.getElementById('unread-count-desktop');
                    const unreadCountMobileEl = document.getElementById('unread-count-mobile');
                    const totalNotificationsMobileIconEl = document.getElementById('total-notifications-mobile-icon');

                    if (newLikesCount > 0) {
                        if (newLikesDesktopEl) {
                            newLikesDesktopEl.textContent = newLikesCount;
                            newLikesDesktopEl.classList.remove('hidden');
                        }
                        if (newLikesMobileEl) {
                            newLikesMobileEl.textContent = newLikesCount;
                            newLikesMobileEl.classList.remove('hidden');
                        }
                    } else {
                        if (newLikesDesktopEl) newLikesDesktopEl.classList.add('hidden');
                        if (newLikesMobileEl) newLikesMobileEl.classList.add('hidden');
                    }

                    if (unreadMessageCount > 0) {
                        if (unreadCountDesktopEl) {
                            unreadCountDesktopEl.textContent = unreadMessageCount;
                            unreadCountDesktopEl.classList.remove('hidden');
                        }
                        if (unreadCountMobileEl) {
                            unreadCountMobileEl.textContent = unreadMessageCount;
                            unreadCountMobileEl.classList.remove('hidden');
                        }
                    } else {
                        if (unreadCountDesktopEl) unreadCountDesktopEl.classList.add('hidden');
                        if (unreadCountMobileEl) unreadCountMobileEl.classList.add('hidden');
                    }
                    
                    if (totalNotifications > 0 && totalNotificationsMobileIconEl) {
                        totalNotificationsMobileIconEl.textContent = totalNotifications;
                        totalNotificationsMobileIconEl.classList.remove('hidden');

                        // **NOVA LÓGICA DE COR DINÂMICA**
                        const colorClassesToRemove = ['bg-red-500', 'bg-orange-500', 'bg-pink-500', 'bg-gradient-to-r', 'from-pink-500', 'to-orange-500'];
                        totalNotificationsMobileIconEl.classList.remove(...colorClassesToRemove);
                        totalNotificationsMobileIconEl.style.backgroundColor = ''; // Limpa a cor de fundo inline, se houver

                        if (newLikesCount > 0 && unreadMessageCount > 0) {
                            // Ambos: Gradiente
                            totalNotificationsMobileIconEl.classList.add('bg-gradient-to-r', 'from-pink-500', 'to-orange-500');
                        } else if (newLikesCount > 0) {
                            // Apenas Curtidas: Laranja
                            totalNotificationsMobileIconEl.classList.add('bg-orange-500');
                        } else {
                            // Apenas Chats: Rosa
                            totalNotificationsMobileIconEl.classList.add('bg-pink-500');
                        }

                    } else if (totalNotificationsMobileIconEl) {
                        totalNotificationsMobileIconEl.classList.add('hidden');
                    }

                    // --- FIM DA LÓGICA DE NOTIFICAÇÃO ---

                } else if (!userDoc.exists()) {
                    signOut(auth);
                }
            });
        } else {
            if (userMenu) {
                userMenu.classList.remove('flex');
                userMenu.classList.add('hidden');
            }
        }
    });
}

function highlightActiveNavLink() {
    const navLinks = document.querySelectorAll('.nav-link');
    const currentPath = window.location.pathname;
    const currentPageName = currentPath.split('/').pop();

    navLinks.forEach(link => {
        const linkPageName = link.dataset.page;
        if (linkPageName === currentPageName) {
            link.classList.remove('text-gray-300', 'hover:text-pink-400');
            link.classList.add('text-pink-500', 'font-medium');
        } else {
            link.classList.remove('text-pink-500');
            link.classList.add('text-gray-300', 'hover:text-pink-400');
        }
    });

    const termsModal = document.getElementById('terms-modal');
    const openTermsLinkMobile = document.getElementById('open-terms-modal-mobile');
    const openTermsLinkDesktop = document.getElementById('open-terms-modal-desktop');
    const closeTermsBtn = document.getElementById('close-terms-modal');
    const closeTermsBtn2 = document.getElementById('close-terms-modal-2');

    function openTermsModal(e) {
        if (e) e.preventDefault();
        termsModal.classList.remove('hidden');
    }

    function closeTermsModal() {
        termsModal.classList.add('hidden');
    }

    if (openTermsLinkMobile) {
        openTermsLinkMobile.addEventListener('click', openTermsModal);
    }
    if (openTermsLinkDesktop) {
        openTermsLinkDesktop.addEventListener('click', openTermsModal);
    }
    if (closeTermsBtn) {
       closeTermsBtn.addEventListener('click', closeTermsModal);
    }
    if (closeTermsBtn2) {
       closeTermsBtn2.addEventListener('click', closeTermsModal);
    }
}