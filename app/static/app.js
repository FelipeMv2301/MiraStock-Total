console.log("[MiraStock-Total] Sistema cargado (v1.7).");

let inputBuffer = '';
let bufferTimeout = null;
let resetTimeout = null;
let resetInterval = null;
let syncInterval = null;
let lastKnownRunning = false;
let currentPage = 1;
let selectedWarehouses = new Set();
let selectedCanal = '';
let sellItemActive = false;
let isAuthenticated = false;
let currentUser = null;

// --- 1. Inicialización ---
async function init() {
    try {
        await checkAuth();
        await startSyncPolling();
        await loadSyncSchedule();
        await loadCategories();
        initMobileSidebar();
        loadCatalog();

        const savedScale = parseFloat(localStorage.getItem('font-scale')) || 1.0;
        document.documentElement.style.fontSize = `${16 * savedScale}px`;
        document.documentElement.style.setProperty('--font-scale', savedScale);

        // Mostrar error de auth si viene en la URL
        const params = new URLSearchParams(window.location.search);
        const authErr = params.get('auth_error');
        if (authErr) {
            const msgs = {
                dominio:         'Solo se permiten cuentas @bioquimica.cl.',
                acceso_denegado: 'Acceso denegado por Google.',
                token_fallido:   'Error al conectar con Google. Intenta de nuevo.',
            };
            const banner = document.getElementById('auth-error-banner');
            if (banner) {
                document.getElementById('auth-error-msg').textContent = msgs[authErr] || 'Error de autenticación.';
                banner.classList.remove('hidden');
            }
            history.replaceState({}, '', '/');
        }
    } catch (err) {
        console.error("Error en init:", err);
    }
}

async function checkAuth() {
    try {
        const res  = await fetch('/auth/me');
        const data = await res.json();
        isAuthenticated = data.authenticated;
        currentUser     = data.user || null;
    } catch {
        isAuthenticated = false;
        currentUser     = null;
    }
    renderAuthWidget();
}

function renderAuthWidget() {
    const widget = document.getElementById('auth-widget');
    if (!widget) return;

    const whBadges = document.getElementById('wh-header-badges');
    if (whBadges) whBadges.classList.toggle('hidden', !isAuthenticated);

    document.getElementById('filter-bodegas')?.classList.toggle('hidden', !isAuthenticated);
    document.getElementById('location-bulk-btn')?.classList.toggle('hidden', !isAuthenticated);
    if (typeof updateUploadFab === 'function') updateUploadFab();

    if (isAuthenticated && currentUser) {
        const firstName = currentUser.name?.split(' ')[0] || currentUser.email;
        widget.innerHTML = `
            <div class="flex items-center gap-2">
                <div class="w-8 h-8 rounded-full border border-gray-200 overflow-hidden bg-gray-100 flex items-center justify-center shrink-0">
                    <img src="${currentUser.picture || ''}" alt="${firstName}"
                        class="w-full h-full object-cover"
                        onerror="this.style.display='none'; document.getElementById('auth-fallback-icon').style.display='flex'">
                    <i id="auth-fallback-icon" class="fas fa-user text-gray-400 text-sm" style="display:none"></i>
                </div>
                <span class="text-xs font-medium text-gray-600 max-w-[100px] truncate">${firstName}</span>
                <a href="/auth/logout"
                    class="w-7 h-7 flex items-center justify-center rounded-full text-gray-400 hover:text-red-500 hover:bg-red-50 transition-all"
                    title="Cerrar sesión">
                    <i class="fas fa-sign-out-alt text-sm"></i>
                </a>
            </div>`;
    } else {
        widget.innerHTML = `
            <a href="/auth/login"
                class="flex items-center gap-2 text-gray-500 hover:text-orange-500 transition-colors"
                title="Iniciar sesión con Google">
                <i class="fas fa-user text-lg"></i>
                <span class="text-xs font-semibold">Iniciar sesión</span>
            </a>`;
    }
}

// --- 2. Navegación ---
function toggleMobileMenu() {
    document.getElementById('secondary-nav')?.classList.toggle('mobile-open');
}

function toggleMobileFilters() {
    const sidebar = document.getElementById('catalog-sidebar');
    const chevron = document.getElementById('mobile-filter-chevron');
    if (!sidebar) return;
    const isHidden = sidebar.style.display === 'none';
    sidebar.style.display = isHidden ? 'block' : 'none';
    chevron?.classList.toggle('rotate-180', isHidden);
}

function initMobileSidebar() {
    const sidebar = document.getElementById('catalog-sidebar');
    if (!sidebar) return;
    if (window.innerWidth < 1024) sidebar.style.display = 'none';
}

window.addEventListener('resize', () => {
    const sidebar = document.getElementById('catalog-sidebar');
    if (!sidebar) return;
    if (window.innerWidth >= 1024) {
        sidebar.style.display = '';
        document.getElementById('mobile-filter-chevron')?.classList.remove('rotate-180');
    }
});

function showView(viewId) {
    const secondaryNav = document.getElementById('secondary-nav');
    if (secondaryNav && window.innerWidth < 768) {
        secondaryNav.classList.remove('mobile-open');
    }
    stopResetTimer();

    document.querySelectorAll('.view').forEach(v => {
        v.classList.add('hidden');
        v.style.opacity = '0';
    });
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));

    if (viewId === 'loading') {
        const home = document.getElementById('home-view');
        home.classList.remove('hidden');
        home.style.opacity = '1';
        document.getElementById('status-text').innerHTML = `
            <div class="flex items-center justify-center gap-2 text-orange-600 font-bold">
                <i class="fas fa-circle-notch fa-spin"></i> Buscando...
            </div>`;
        document.getElementById('nav-home').classList.add('active');
        return;
    }

    const target = document.getElementById(viewId);
    if (!target) return;
    target.classList.remove('hidden');
    setTimeout(() => (target.style.opacity = '1'), 10);

    if (viewId === 'home-view' || viewId === 'product-view') {
        document.getElementById('nav-home').classList.add('active');
        if (viewId === 'home-view') {
            document.getElementById('status-text').innerHTML = '<p>Esperando escaneo...</p>';
        }
    } else if (viewId === 'catalog-view') {
        document.getElementById('nav-catalog').classList.add('active');
        loadCatalog();
    }
}

// --- 3. Escáner ---
document.addEventListener('keydown', (e) => {
    if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) return;
    if (!document.getElementById('product-modal').classList.contains('hidden')) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    clearTimeout(bufferTimeout);

    if (e.key === 'Enter') {
        const trimmed = inputBuffer.trim();
        if (trimmed.length > 0) {
            lookupProduct(trimmed);
            inputBuffer = '';
        } else {
            resetApp();
        }
    } else if (e.key.length === 1) {
        inputBuffer += e.key;
        bufferTimeout = setTimeout(() => { inputBuffer = ''; }, 300);
    }
});

document.getElementById('manual-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const sku = document.getElementById('manual-sku').value.trim();
    if (sku) {
        lookupProduct(sku);
        document.getElementById('manual-sku').value = '';
        document.getElementById('manual-sku').blur();
    }
});

async function lookupProduct(sku) {
    showView('loading');
    try {
        const res = await fetch(`/api/product/${sku.toUpperCase()}`);
        const data = await res.json();
        if (res.ok && data.status === 'success') {
            displayProduct(data.product);
            startResetTimer();
        } else {
            showError('Producto no encontrado en el catálogo', sku);
            startResetTimer();
        }
    } catch (err) {
        console.error("Error en lookup:", err);
        showError(err && err.message ? `Error: ${err.message}` : 'Error de red o servidor', sku);
        startResetTimer();
    }
}

function displayProduct(p) {
    showView('product-view');

    document.getElementById('product-sku').textContent  = p.sku || '';
    document.getElementById('product-name').textContent = p.name || 'Sin nombre';
    document.getElementById('product-price').textContent = formatPrice(p.price);


    const imgCol = document.getElementById('product-image-col');
    const imgEl  = document.getElementById('product-image');
    const urls   = p.image_urls || [];
    if (urls.length) {
        imgEl.src = urls[0];
        imgCol.classList.remove('hidden');
        imgCol.classList.add('flex');
    } else {
        imgCol.classList.add('hidden');
        imgCol.classList.remove('flex');
    }

    // Auth: stock por bodega + total. Público: solo stock tienda y web.
    const isAuthView = p.stock_01 !== undefined;
    document.getElementById('product-wh-auth').classList.toggle('hidden', !isAuthView);
    document.getElementById('product-wh-public').classList.toggle('hidden', isAuthView);
    document.getElementById('product-total-box').classList.toggle('hidden', !isAuthView);

    if (isAuthView) {
        document.getElementById('product-stock-01').textContent    = Math.round(p.stock_01 || 0);
        document.getElementById('product-stock-11').textContent    = Math.round(p.stock_11 || 0);
        document.getElementById('product-stock-15').textContent    = Math.round(p.stock_15 || 0);
        document.getElementById('product-stock-30').textContent    = Math.round(p.stock_30 || 0);
        document.getElementById('product-total-stock').textContent = Math.round(p.total_stock || 0);
    } else {
        document.getElementById('product-stock-tienda').textContent = Math.round(p.stock_tienda || 0);
        document.getElementById('product-stock-web').textContent    = Math.round(p.stock_web || 0);
    }
}

// --- 4. Catálogo ---
async function loadCatalog(search = '', page = 1) {
    const grid       = document.getElementById('catalog-grid');
    const loading    = document.getElementById('catalog-loading');
    const empty      = document.getElementById('catalog-empty');
    const pagination = document.getElementById('pagination-controls');

    if (search === null) search = document.getElementById('catalog-search').value;

    grid.innerHTML = '';
    loading.classList.remove('hidden');
    empty.classList.add('hidden');
    pagination.innerHTML = '';

    try {
        const type      = 'all';
        const stock     = document.getElementById('catalog-stock-status').value;
        const whsParam  = [...selectedWarehouses].join(',');
        const sellParam = (!isAuthenticated || sellItemActive) ? 'yes' : 'all';
        const category  = document.getElementById('catalog-category').value;
        const url = `/api/products?search=${encodeURIComponent(search)}&item_type=${encodeURIComponent(type)}&stock_filter=${stock}&warehouses=${whsParam}&sell_item=${sellParam}&category=${encodeURIComponent(category)}&channel=${selectedCanal}&page=${page}`;
        const res  = await fetch(url);
        const data = await res.json();

        renderCatalog(data.products || []);
        renderPagination(data.pagination || {});
        currentPage = data.pagination?.current_page || 1;
    } catch (err) {
        console.error("Error cargando catálogo:", err);
    } finally {
        loading.classList.add('hidden');
    }
}

function toggleWarehouse(code) {
    if (selectedWarehouses.has(code)) {
        selectedWarehouses.delete(code);
    } else {
        selectedWarehouses.add(code);
    }
    document.getElementById(`wh-btn-${code}`)?.classList.toggle('active', selectedWarehouses.has(code));
    loadCatalog(document.getElementById('catalog-search').value, 1);
}

function toggleCanal(code) {
    if (selectedCanal === code) {
        selectedCanal = '';
    } else {
        selectedCanal = code;
    }
    ['tienda', 'web', 'ambos'].forEach(c => {
        document.getElementById(`canal-btn-${c}`)?.classList.toggle('active', selectedCanal === c);
    });
    loadCatalog(document.getElementById('catalog-search').value, 1);
}

function toggleSellItem() {
    sellItemActive = !sellItemActive;
    const btn   = document.getElementById('sell-item-btn');
    const check = document.getElementById('sell-item-check');
    if (sellItemActive) {
        btn?.classList.add('sell-item-active');
        if (check) check.classList.remove('opacity-0');
    } else {
        btn?.classList.remove('sell-item-active');
        if (check) check.classList.add('opacity-0');
    }
    loadCatalog(document.getElementById('catalog-search').value, 1);
}

function resolveWebPrice(p) {
    const salePrice    = parseFloat(p.woo_sale_price)    || 0;
    const regularPrice = parseFloat(p.woo_regular_price) || 0;
    const sapNeto      = parseFloat(p.price)             || 0;

    if (salePrice > 0 && regularPrice > salePrice) {
        const pct = Math.round((1 - salePrice / regularPrice) * 100);
        return { price: salePrice, regular: regularPrice, pct, label: 'Precio web' };
    }
    if (regularPrice > 0) {
        return { price: regularPrice, regular: 0, pct: 0, label: 'Precio web' };
    }
    return { price: priceWithIva(sapNeto), regular: 0, pct: 0, label: 'Precio (+IVA)' };
}

function priceWithIva(price) {
    return Math.round((parseFloat(price) || 0) * 1.19);
}

function renderCatalog(products) {
    const grid  = document.getElementById('catalog-grid');
    const empty = document.getElementById('catalog-empty');
    grid.innerHTML = '';

    if (!products.length) {
        empty.classList.remove('hidden');
        return;
    }

    products.forEach(p => {
        const total    = Math.round(p.total_stock || 0);
        const hasStock = total > 0;
        const stockCls = hasStock ? 'text-green-600' : 'text-red-400';
        const imgSrc   = (p.image_urls && p.image_urls[0]) || 'img/logo_bioquimica.png';
        const web      = resolveWebPrice(p);

        const card = document.createElement('div');
        card.className = 'product-card group bg-white rounded-[2rem] border border-gray-100 overflow-hidden shadow-sm hover:shadow-xl transition-all duration-300 flex flex-col';
        card.dataset.sku = p.sku;
        card.innerHTML = `
            <div class="aspect-square w-full bg-gray-50 flex items-center justify-center p-6 overflow-hidden relative">
                <img src="${imgSrc}" alt="${escapeHtml(p.name)}"
                    class="w-full h-full object-contain transition-transform duration-500 group-hover:scale-110"
                    onerror="this.src='img/logo_bioquimica.png'">
                ${web.pct > 0 ? `<div class="absolute top-4 left-4">
                    <span class="text-[9px] font-extrabold px-2 py-1 rounded-lg bg-red-500 text-white shadow-sm">-${web.pct}%</span>
                </div>` : ''}
            </div>
            <div class="p-5 flex-1 flex flex-col gap-3">
                <div>
                    <h3 class="text-sm font-semibold text-gray-800 leading-snug line-clamp-2 mb-1">${escapeHtml(p.name)}</h3>
                    <span class="text-xs font-bold font-mono text-gray-600">${p.sku}</span>
                </div>

                <div class="mt-auto space-y-2">
                    ${isAuthenticated ? `
                    <div class="flex items-center justify-between">
                        <span class="text-xs font-bold text-gray-500 uppercase">Stock total</span>
                        <div class="flex items-baseline gap-1">
                            <span class="text-xl font-black ${stockCls}">${total}</span>
                            <span class="text-xs font-bold text-gray-500">un.</span>
                        </div>
                    </div>` : `
                    <div class="flex items-center gap-3">
                        <span class="text-xs font-bold text-gray-500 uppercase">Tienda</span>
                        <span class="text-sm font-black ${Math.round(p.stock_tienda||0)>0?'text-orange-500':'text-gray-300'}">${Math.round(p.stock_tienda||0)}</span>
                        <span class="text-gray-300">|</span>
                        <span class="text-xs font-bold text-gray-500 uppercase">Web</span>
                        <span class="text-sm font-black ${Math.round(p.stock_web||0)>0?'text-blue-500':'text-gray-300'}">${Math.round(p.stock_web||0)}</span>
                    </div>`}

                    <div class="pt-2 border-t border-gray-100 space-y-1">
                        <div class="flex items-center justify-between">
                            <span class="text-xs font-bold text-gray-500 uppercase">${web.label}</span>
                            <div class="flex items-center gap-1.5">
                                ${web.regular > 0 ? `<span class="text-xs text-gray-500 line-through">${formatPrice(web.regular)}</span>` : ''}
                                <span class="text-base font-bold text-slate-800">${formatPrice(web.price)}</span>
                            </div>
                        </div>
                        ${isAuthenticated ? `
                        <div class="flex items-center justify-between">
                            <span class="text-xs font-semibold text-gray-500 uppercase">Neto SAP</span>
                            <span class="text-sm font-semibold text-gray-600">${formatPrice(p.price)}</span>
                        </div>` : ''}
                    </div>

                    <button class="ver-mas-btn w-full py-2 rounded-xl bg-orange-50 hover:bg-orange-100 text-orange-600 font-bold text-xs transition-all active:scale-95 flex items-center justify-center gap-1.5">
                        <i class="fas fa-expand-alt text-[10px]"></i> Ver más
                    </button>
                </div>
            </div>
        `;
        card.querySelector('.ver-mas-btn').onclick = () => openProductModal(p);
        grid.appendChild(card);
    });
}

function renderPagination(info) {
    const container = document.getElementById('pagination-controls');
    container.innerHTML = '';
    if (!info.total_pages || info.total_pages <= 1) return;

    const prev = document.createElement('button');
    prev.className = `px-4 py-2 rounded-xl font-bold transition-all ${info.current_page > 1 ? 'bg-white hover:bg-gray-50 border text-gray-700' : 'bg-gray-50 text-gray-300 cursor-not-allowed border'}`;
    prev.innerHTML = '<i class="fas fa-chevron-left"></i>';
    prev.onclick = () => info.current_page > 1 && loadCatalog(null, info.current_page - 1);
    container.appendChild(prev);

    const pageInfo = document.createElement('span');
    pageInfo.className = "px-6 py-2 font-bold text-gray-600 bg-gray-100 rounded-xl";
    pageInfo.textContent = `Página ${info.current_page} de ${info.total_pages} (${info.total_items} ítems)`;
    container.appendChild(pageInfo);

    const next = document.createElement('button');
    next.className = `px-4 py-2 rounded-xl font-bold transition-all ${info.current_page < info.total_pages ? 'bg-white hover:bg-gray-50 border text-gray-700' : 'bg-gray-50 text-gray-300 cursor-not-allowed border'}`;
    next.innerHTML = '<i class="fas fa-chevron-right"></i>';
    next.onclick = () => info.current_page < info.total_pages && loadCatalog(null, info.current_page + 1);
    container.appendChild(next);
}

function clearFilters() {
    document.getElementById('catalog-search').value = '';
    document.getElementById('catalog-stock-status').value = 'instock';
    document.getElementById('catalog-category').value = '';

    selectedWarehouses.clear();
    ['01', '11', '15', '30'].forEach(code =>
        document.getElementById(`wh-btn-${code}`)?.classList.remove('active')
    );

    selectedCanal = '';
    ['tienda', 'web', 'ambos'].forEach(c =>
        document.getElementById(`canal-btn-${c}`)?.classList.remove('active')
    );

    if (sellItemActive) toggleSellItem();

    loadCatalog('', 1);
}

// --- 5. Filtros catálogo ---
let searchTimeout;
document.getElementById('catalog-search').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => loadCatalog(e.target.value, 1), 400);
});
document.getElementById('catalog-stock-status').addEventListener('change', () =>
    loadCatalog(document.getElementById('catalog-search').value, 1));
document.getElementById('catalog-category').addEventListener('change', () =>
    loadCatalog(document.getElementById('catalog-search').value, 1));

async function loadCategories() {
    try {
        const res  = await fetch('/api/categories');
        if (!res.ok) return;
        const cats = await res.json();
        const sel  = document.getElementById('catalog-category');
        if (!sel) return;
        cats.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.slug;
            opt.textContent = c.name;
            sel.appendChild(opt);
        });
    } catch (err) {
        console.error("Error cargando categorías:", err);
    }
}

// --- 6. Modal de detalle ---
function openProductModal(p) {
    const total = Math.round(p.total_stock || 0);

    document.getElementById('modal-sku').textContent         = p.sku;
    document.getElementById('modal-title').textContent       = p.name;
    document.getElementById('modal-total-stock').textContent = total;

    // Descripción
    const descWrap = document.getElementById('modal-description-wrap');
    const descEl   = document.getElementById('modal-description');
    if (p.description) {
        if (descEl) descEl.innerHTML = p.description;
        descWrap?.classList.remove('hidden');
    } else {
        descWrap?.classList.add('hidden');
    }

    // Ubicación en tienda
    const locWrap = document.getElementById('modal-location-wrap');
    const locText = document.getElementById('modal-location-text');
    const locEditBtn = document.getElementById('modal-location-edit-btn');
    if (locWrap) {
        if (isAuthenticated) {
            locWrap.classList.remove('hidden');
            if (locText) {
                locText.textContent = p.location || '';
                locText.className = p.location
                    ? 'text-sm font-bold text-slate-700 bg-amber-50 border border-amber-100 rounded-xl px-4 py-3 min-h-[44px]'
                    : 'text-sm italic text-gray-400 bg-gray-50 border border-gray-100 rounded-xl px-4 py-3 min-h-[44px]';
                if (!p.location && isAuthenticated) locText.textContent = 'Sin ubicación registrada';
            }
            if (locEditBtn) locEditBtn.classList.toggle('hidden', !isAuthenticated);
            document.getElementById('modal-location-read')?.classList.remove('hidden');
            document.getElementById('modal-location-edit')?.classList.add('hidden');
        } else {
            locWrap.classList.add('hidden');
        }
    }


    // Precio web
    const web = resolveWebPrice(p);

    document.getElementById('modal-price-label').textContent = web.label;
    document.getElementById('modal-web-price').textContent   = formatPrice(web.price);

    const strikeEl = document.getElementById('modal-regular-price-strike');
    if (web.regular > 0) {
        strikeEl.textContent = formatPrice(web.regular);
        strikeEl.classList.remove('hidden');
    } else {
        strikeEl.classList.add('hidden');
    }

    const discEl = document.getElementById('modal-discount-pct');
    if (web.pct > 0) {
        discEl.textContent = `-${web.pct}%`;
        discEl.classList.remove('hidden');
    } else {
        discEl.classList.add('hidden');
    }

    document.getElementById('modal-price').textContent     = formatPrice(p.price);
    document.getElementById('modal-price-iva').textContent = formatPrice(priceWithIva(p.price));

    // Fila neto SAP: solo para autenticados
    const netoRow = document.getElementById('modal-neto-row');
    if (netoRow) netoRow.classList.toggle('hidden', !isAuthenticated);

    // Bodegas
    const wlDiv      = document.getElementById('modal-warehouse-list');
    const stockTitle = document.getElementById('modal-stock-title');

    if (isAuthenticated) {
        if (stockTitle) stockTitle.textContent = 'Stock por bodega';
        const s01 = Math.round(p.stock_01 || 0);
        const s11 = Math.round(p.stock_11 || 0);
        const s15 = Math.round(p.stock_15 || 0);
        const s30 = Math.round(p.stock_30 || 0);
        const tienda = s15;
        const webS   = s01 + s11;
        const warehouses = [
            { code: '01', label: 'Bodega 01', value: s01, barColor: '#f59e0b' },
            { code: '11', label: 'Bodega 11', value: s11, barColor: '#3b82f6' },
            { code: '15', label: 'Bodega 15', value: s15, barColor: '#22c55e' },
            { code: '30', label: 'Bodega 30', value: s30, barColor: '#a855f7' },
        ];
        const maxStock = Math.max(1, ...warehouses.map(w => w.value));
        wlDiv.innerHTML = `
            <div class="flex gap-3 mb-3">
                <div class="flex-1 bg-orange-50 rounded-xl p-3 text-center border border-orange-100">
                    <span class="text-xs font-bold text-orange-400 uppercase block mb-1">Tienda (B15)</span>
                    <span class="text-2xl font-black ${tienda > 0 ? 'text-orange-600' : 'text-gray-300'}">${tienda}</span>
                </div>
                <div class="flex-1 bg-blue-50 rounded-xl p-3 text-center border border-blue-100">
                    <span class="text-xs font-bold text-blue-400 uppercase block mb-1">Web (B01+B11)</span>
                    <span class="text-2xl font-black ${webS > 0 ? 'text-blue-600' : 'text-gray-300'}">${webS}</span>
                </div>
            </div>` +
            warehouses.map(w => {
            const pct = Math.round((w.value / maxStock) * 100);
            return `
                <div class="wh-row wh-${w.code}">
                    <span class="text-xs font-bold w-20 shrink-0">${w.label}</span>
                    <div class="flex-1 bg-white/60 rounded-full h-2.5 overflow-hidden">
                        <div class="h-full rounded-full transition-all duration-500"
                             style="width:${pct}%; background-color:${w.barColor}"></div>
                    </div>
                    <span class="text-base font-black w-14 text-right">${w.value}</span>
                </div>`;
        }).join('');
    } else {
        if (stockTitle) stockTitle.textContent = 'Disponibilidad';
        const tienda = Math.round(p.stock_tienda || 0);
        const webS   = Math.round(p.stock_web    || 0);
        wlDiv.innerHTML = `
            <div class="flex gap-3">
                <div class="flex-1 bg-orange-50 rounded-xl p-3 text-center border border-orange-100">
                    <span class="text-[9px] font-bold text-orange-400 uppercase block mb-1">Tienda</span>
                    <span class="text-2xl font-black ${tienda > 0 ? 'text-orange-600' : 'text-gray-300'}">${tienda}</span>
                </div>
                <div class="flex-1 bg-blue-50 rounded-xl p-3 text-center border border-blue-100">
                    <span class="text-[9px] font-bold text-blue-400 uppercase block mb-1">Web</span>
                    <span class="text-2xl font-black ${webS > 0 ? 'text-blue-600' : 'text-gray-300'}">${webS}</span>
                </div>
            </div>`;
    }

    // Galería modal
    initModalGallery(p);

    document.getElementById('product-modal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closeProductModal() {
    document.getElementById('product-modal').classList.add('hidden');
    document.body.style.overflow = 'auto';
}

// --- 7. Sincronización ---
async function triggerSync() {
    try {
        await fetch('/api/trigger-sync', { method: 'POST' });
        startSyncPolling();
    } catch (err) {
        console.error("Error al iniciar sync:", err);
    }
}

async function startSyncPolling() {
    if (syncInterval) clearInterval(syncInterval);
    syncInterval = setInterval(async () => {
        try {
            const res    = await fetch('/api/sync-status');
            const status = await res.json();
            const text    = document.getElementById('sync-text');
            const spinner = document.getElementById('sync-spinner');

            if (status.is_running) {
                text.textContent = `Sincronizando SAP... (${status.progress}%)`;
                spinner.classList.remove('hidden');
                lastKnownRunning = true;
            } else {
                spinner.classList.add('hidden');
                text.textContent = status.last_sync
                    ? `Actualizado: ${status.last_sync}`
                    : status.message || 'Sin sincronizar';

                if (lastKnownRunning && status.progress === 100) {
                    loadCatalog(document.getElementById('catalog-search').value);
                    loadSyncSchedule();
                    lastKnownRunning = false;
                }
            }
        } catch (err) {
            console.error("Error en polling de sync:", err);
        }
    }, 2000);
}

async function loadSyncSchedule() {
    try {
        const res  = await fetch('/api/sync-schedule');
        if (!res.ok) return;
        const data = await res.json();
        const el   = document.getElementById('next-sync-text');
        if (!el) return;
        if (data.next_sync) {
            const time = data.next_sync.split(' ')[1]?.slice(0, 5) || data.next_sync;
            el.textContent = `Próx. sync: ${time} (c/${data.interval_minutes}m)`;
        } else {
            el.textContent = `Auto-sync: cada ${data.interval_minutes}m`;
        }
    } catch (err) {
        console.error("Error cargando schedule:", err);
    }
}

// --- 8. Utilidades ---
function formatPrice(price) {
    const n = parseInt(price) || 0;
    if (n === 0) return '$0';
    return `$${n.toLocaleString('es-CL')}`;
}

function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showError(message, sku = '') {
    document.getElementById('error-message').textContent = message;
    document.getElementById('error-sku').textContent = sku ? `SKU buscado: ${sku}` : '';
    showView('error-view');
}

function startResetTimer() {
    stopResetTimer();
    let timeLeft = 100;
    const p1 = document.getElementById('reset-progress');
    const p2 = document.getElementById('reset-progress-error');

    document.getElementById('restart-btn-product').classList.add('hidden');
    document.getElementById('restart-btn-error').classList.add('hidden');

    resetInterval = setInterval(() => {
        timeLeft -= 2;
        if (p1) p1.style.width = `${timeLeft}%`;
        if (p2) p2.style.width = `${timeLeft}%`;
        if (timeLeft <= 0) clearInterval(resetInterval);
    }, 100);

    resetTimeout = setTimeout(() => {
        document.getElementById('restart-btn-product').classList.remove('hidden');
        document.getElementById('restart-btn-error').classList.remove('hidden');
    }, 5000);
}

function stopResetTimer() {
    clearTimeout(resetTimeout);
    clearInterval(resetInterval);
}

function resetApp() {
    showView('home-view');
    document.getElementById('manual-sku').focus();
}

function changeFontSize(delta) {
    const root = document.documentElement;
    let scale = Math.round(((parseFloat(localStorage.getItem('font-scale')) || 1.0) + delta) * 10) / 10;
    scale = Math.min(1.8, Math.max(0.7, scale));
    root.style.fontSize = `${16 * scale}px`;
    root.style.setProperty('--font-scale', scale);
    localStorage.setItem('font-scale', scale);
}

// --- 9. Galería modal ---
let galleryUrls = [];
let galleryIdx  = 0;
let currentModalSku = '';

function initModalGallery(p) {
    galleryUrls = p.image_urls || [];
    galleryIdx  = 0;
    currentModalSku = p.sku || '';

    const col    = document.getElementById('modal-image-col');
    const imgEl  = document.getElementById('modal-image');
    const dots   = document.getElementById('modal-img-dots');
    const prev   = document.getElementById('modal-img-prev');
    const next   = document.getElementById('modal-img-next');
    const upBtn  = document.getElementById('modal-upload-btn');

    if (!galleryUrls.length) {
        col.classList.add('hidden');
        col.classList.remove('flex');
        if (upBtn) upBtn.classList.toggle('hidden', !isAuthenticated);
        if (upBtn && isAuthenticated) {
            col.classList.remove('hidden');
            col.classList.add('flex');
        }
        if (imgEl) imgEl.src = '';
        if (dots)  dots.innerHTML = '';
        if (prev)  prev.classList.add('hidden');
        if (next)  next.classList.add('hidden');
    } else {
        col.classList.remove('hidden');
        col.classList.add('flex');
        renderGalleryFrame();
    }

    if (upBtn) upBtn.classList.toggle('hidden', !isAuthenticated);
}

function renderGalleryFrame() {
    const imgEl = document.getElementById('modal-image');
    const dots  = document.getElementById('modal-img-dots');
    const prev  = document.getElementById('modal-img-prev');
    const next  = document.getElementById('modal-img-next');

    if (imgEl) imgEl.src = galleryUrls[galleryIdx] || '';

    if (dots) {
        const showDots = galleryUrls.length > 1;
        dots.innerHTML = showDots
            ? galleryUrls.map((_, i) => `
                <button onclick="modalGalleryNav(${i - galleryIdx})"
                    class="w-2 h-2 rounded-full transition-all ${i === galleryIdx ? 'bg-orange-500 scale-125' : 'bg-gray-300 hover:bg-gray-400'}">
                </button>`).join('')
            : '';
    }

    // Botón eliminar imagen actual (solo auth)
    const delBtn = document.getElementById('modal-img-delete');
    if (delBtn) {
        delBtn.classList.toggle('hidden', !isAuthenticated || !galleryUrls.length);
    }

    const multi = galleryUrls.length > 1;
    if (prev) prev.classList.toggle('hidden', !multi || galleryIdx === 0);
    if (next) next.classList.toggle('hidden', !multi || galleryIdx === galleryUrls.length - 1);
}

function modalGalleryNav(delta) {
    galleryIdx = Math.max(0, Math.min(galleryUrls.length - 1, galleryIdx + delta));
    renderGalleryFrame();
}

async function deleteCurrentImage() {
    if (!currentModalSku || !galleryUrls.length) return;
    if (!confirm(`¿Eliminar imagen ${galleryIdx + 1} de ${currentModalSku}?`)) return;

    try {
        const res  = await fetch(`/api/product/${currentModalSku}/images/${galleryIdx + 1}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Error al eliminar');

        galleryUrls = data.image_urls || [];
        galleryIdx  = Math.max(0, Math.min(galleryIdx, galleryUrls.length - 1));
        initModalGallery({ sku: currentModalSku, image_urls: galleryUrls });

        // Actualizar tarjeta en el catálogo
        const card = document.querySelector(`[data-sku="${currentModalSku}"]`);
        if (card) {
            const img = card.querySelector('img');
            if (img) img.src = galleryUrls[0] || 'img/logo_bioquimica.png';
        }
    } catch (e) {
        alert(e.message);
    }
}

// --- 10. Upload individual ---
let uploadFiles = [];

function openUploadModal() {
    uploadFiles = [];
    document.getElementById('upload-file-input').value = '';
    document.getElementById('upload-preview').innerHTML = '';
    document.getElementById('upload-preview').classList.add('hidden');
    document.getElementById('upload-progress-wrap').classList.add('hidden');
    document.getElementById('upload-error').classList.add('hidden');
    document.getElementById('upload-submit-btn').classList.add('hidden');
    document.getElementById('upload-modal-sku').textContent = `SKU: ${currentModalSku}`;
    document.getElementById('upload-modal').classList.remove('hidden');
}

function closeUploadModal() {
    document.getElementById('upload-modal').classList.add('hidden');
}

function handleUploadFiles() {
    const input = document.getElementById('upload-file-input');
    uploadFiles = Array.from(input.files || []);
    const preview = document.getElementById('upload-preview');
    if (!uploadFiles.length) {
        preview.classList.add('hidden');
        document.getElementById('upload-submit-btn').classList.add('hidden');
        return;
    }
    preview.innerHTML = uploadFiles.map(f =>
        `<span class="text-xs bg-gray-100 px-2 py-1 rounded-lg font-mono truncate max-w-[140px]">${escapeHtml(f.name)}</span>`
    ).join('');
    preview.classList.remove('hidden');
    document.getElementById('upload-submit-btn').classList.remove('hidden');
}

async function submitUpload() {
    if (!uploadFiles.length || !currentModalSku) return;

    const btn      = document.getElementById('upload-submit-btn');
    const progWrap = document.getElementById('upload-progress-wrap');
    const progBar  = document.getElementById('upload-progress-bar');
    const progText = document.getElementById('upload-progress-text');
    const errEl    = document.getElementById('upload-error');

    btn.disabled = true;
    progWrap.classList.remove('hidden');
    errEl.classList.add('hidden');
    progBar.style.width = '30%';
    progText.textContent = 'Subiendo a Drive...';

    const fd = new FormData();
    uploadFiles.forEach(f => fd.append('files', f));

    try {
        const res  = await fetch(`/api/product/${currentModalSku}/images`, { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Error al subir');

        progBar.style.width = '100%';
        progText.textContent = `¡Listo! ${data.image_count} imagen(es) en total.`;

        galleryUrls = data.image_urls || [];
        galleryIdx  = galleryUrls.length - 1;
        renderGalleryFrame();

        setTimeout(() => {
            closeUploadModal();
            loadCatalog(document.getElementById('catalog-search').value, currentPage);
        }, 1500);
    } catch (e) {
        errEl.textContent = e.message;
        errEl.classList.remove('hidden');
        progWrap.classList.add('hidden');
    } finally {
        btn.disabled = false;
    }
}

// --- 11. Carga masiva ---
let bulkFiles = [];
let bulkConflicts = [];

function openBulkModal() {
    bulkFiles = [];
    bulkConflicts = [];
    document.getElementById('bulk-file-input').value = '';
    document.getElementById('bulk-file-count').classList.add('hidden');
    document.getElementById('bulk-conflict-wrap').classList.add('hidden');
    document.getElementById('bulk-progress-wrap').classList.add('hidden');
    document.getElementById('bulk-error').classList.add('hidden');
    document.getElementById('bulk-check-btn').classList.add('hidden');
    document.getElementById('bulk-submit-btn').classList.add('hidden');
    document.getElementById('bulk-modal').classList.remove('hidden');
}

function closeBulkModal() {
    document.getElementById('bulk-modal').classList.add('hidden');
}

function handleBulkFiles() {
    const input = document.getElementById('bulk-file-input');
    bulkFiles = Array.from(input.files || []);
    const countEl = document.getElementById('bulk-file-count');
    document.getElementById('bulk-conflict-wrap').classList.add('hidden');
    document.getElementById('bulk-submit-btn').classList.add('hidden');

    if (!bulkFiles.length) {
        countEl.classList.add('hidden');
        document.getElementById('bulk-check-btn').classList.add('hidden');
        return;
    }
    countEl.textContent = `${bulkFiles.length} archivo(s) seleccionado(s)`;
    countEl.classList.remove('hidden');
    document.getElementById('bulk-check-btn').classList.remove('hidden');
}

async function checkBulkConflicts() {
    if (!bulkFiles.length) return;

    const btn    = document.getElementById('bulk-check-btn');
    const errEl  = document.getElementById('bulk-error');
    btn.disabled = true;
    errEl.classList.add('hidden');

    const fd = new FormData();
    bulkFiles.forEach(f => fd.append('files', f));

    try {
        const res  = await fetch('/api/images/bulk-upload/check', { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) {
            const msg = data.detail?.parse_errors?.join('\n') || data.detail || 'Error';
            throw new Error(msg);
        }

        bulkConflicts = data.conflicts || [];
        const conflictWrap = document.getElementById('bulk-conflict-wrap');
        const conflictList = document.getElementById('bulk-conflict-list');

        if (bulkConflicts.length) {
            conflictList.innerHTML = bulkConflicts.map(c =>
                `<li>${escapeHtml(c)}</li>`
            ).join('');
            conflictWrap.classList.remove('hidden');
        } else {
            conflictWrap.classList.add('hidden');
        }

        document.getElementById('bulk-submit-btn').textContent =
            bulkConflicts.length ? ' Sobreescribir todo y subir' : ' Subir todo';
        document.getElementById('bulk-submit-btn').innerHTML =
            `<i class="fas fa-upload mr-2"></i>${bulkConflicts.length ? 'Sobreescribir todo y subir' : 'Subir todo'}`;
        document.getElementById('bulk-submit-btn').classList.remove('hidden');

    } catch (e) {
        errEl.textContent = e.message;
        errEl.classList.remove('hidden');
    } finally {
        btn.disabled = false;
    }
}

async function submitBulkUpload() {
    if (!bulkFiles.length) return;

    const btn      = document.getElementById('bulk-submit-btn');
    const progWrap = document.getElementById('bulk-progress-wrap');
    const progBar  = document.getElementById('bulk-progress-bar');
    const progText = document.getElementById('bulk-progress-text');
    const errEl    = document.getElementById('bulk-error');

    btn.disabled = true;
    progWrap.classList.remove('hidden');
    errEl.classList.add('hidden');
    progBar.style.width = '10%';
    progText.textContent = 'Enviando archivos...';

    const fd = new FormData();
    bulkFiles.forEach(f => fd.append('files', f));

    try {
        const res  = await fetch('/api/images/bulk-upload?overwrite=true', { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Error al iniciar carga');

        progBar.style.width = '30%';
        progText.textContent = data.message || 'Procesando en background...';

        pollBulkProgress(progBar, progText);
    } catch (e) {
        errEl.textContent = e.message;
        errEl.classList.remove('hidden');
        progWrap.classList.add('hidden');
        btn.disabled = false;
    }
}

function pollBulkProgress(bar, text) {
    const iv = setInterval(async () => {
        try {
            const res    = await fetch('/api/upload-status');
            const status = await res.json();
            const pct    = status.total > 0 ? Math.round((status.done / status.total) * 100) : 0;
            bar.style.width = `${Math.max(30, pct)}%`;
            text.textContent = status.message || `${status.done}/${status.total} imágenes...`;

            if (!status.is_running) {
                clearInterval(iv);
                bar.style.width = '100%';
                if (status.errors?.length) {
                    document.getElementById('bulk-error').textContent = `Completado con ${status.errors.length} error(es).`;
                    document.getElementById('bulk-error').classList.remove('hidden');
                }
                document.getElementById('bulk-submit-btn').disabled = false;
            }
        } catch { clearInterval(iv); }
    }, 2000);
}

// Mostrar FAB de carga masiva solo para auth
function updateUploadFab() {
    document.getElementById('bulk-upload-fab')?.classList.toggle('hidden', !isAuthenticated);
}

// --- 12. Edición de ubicación ---
function startLocationEdit() {
    const input = document.getElementById('modal-location-input');
    const text  = document.getElementById('modal-location-text');
    if (input && text) input.value = (text.textContent === 'Sin ubicación registrada') ? '' : text.textContent;
    document.getElementById('modal-location-read')?.classList.add('hidden');
    document.getElementById('modal-location-edit')?.classList.remove('hidden');
    input?.focus();
}

function cancelLocationEdit() {
    document.getElementById('modal-location-read')?.classList.remove('hidden');
    document.getElementById('modal-location-edit')?.classList.add('hidden');
}

async function saveLocation() {
    const input = document.getElementById('modal-location-input');
    if (!input || !currentModalSku) return;
    const location = input.value.trim();
    try {
        const res = await fetch(`/api/product/${currentModalSku}/location`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ location }),
        });
        if (!res.ok) throw new Error('Error al guardar');
        const data = await res.json();
        const text = document.getElementById('modal-location-text');
        if (text) {
            text.textContent = data.location || 'Sin ubicación registrada';
            text.className = data.location
                ? 'text-sm font-bold text-slate-700 bg-amber-50 border border-amber-100 rounded-xl px-4 py-3 min-h-[44px]'
                : 'text-sm italic text-gray-400 bg-gray-50 border border-gray-100 rounded-xl px-4 py-3 min-h-[44px]';
        }
        cancelLocationEdit();
    } catch (e) {
        alert(e.message);
    }
}

// --- 13. Carga masiva de ubicaciones ---
let locationBulkFile = null;

function openLocationBulkModal() {
    locationBulkFile = null;
    const fileInput = document.getElementById('location-bulk-file');
    if (fileInput) fileInput.value = '';
    document.getElementById('location-bulk-filename')?.classList.add('hidden');
    document.getElementById('location-bulk-progress')?.classList.add('hidden');
    document.getElementById('location-bulk-result')?.classList.add('hidden');
    document.getElementById('location-bulk-submit')?.classList.add('hidden');
    document.getElementById('location-bulk-modal')?.classList.remove('hidden');
}

function closeLocationBulkModal() {
    document.getElementById('location-bulk-modal')?.classList.add('hidden');
}

function handleLocationBulkFile() {
    const input = document.getElementById('location-bulk-file');
    locationBulkFile = input?.files?.[0] || null;
    const nameEl = document.getElementById('location-bulk-filename');
    if (locationBulkFile && nameEl) {
        nameEl.textContent = locationBulkFile.name;
        nameEl.classList.remove('hidden');
        document.getElementById('location-bulk-submit')?.classList.remove('hidden');
        document.getElementById('location-bulk-result')?.classList.add('hidden');
    }
}

async function submitLocationBulk() {
    if (!locationBulkFile) return;
    const btn     = document.getElementById('location-bulk-submit');
    const prog    = document.getElementById('location-bulk-progress');
    const bar     = document.getElementById('location-bulk-progress-bar');
    const progTxt = document.getElementById('location-bulk-progress-text');
    const result  = document.getElementById('location-bulk-result');

    if (btn) btn.disabled = true;
    prog?.classList.remove('hidden');
    result?.classList.add('hidden');
    if (bar) bar.style.width = '30%';
    if (progTxt) progTxt.textContent = 'Subiendo archivo...';

    const fd = new FormData();
    fd.append('file', locationBulkFile);

    try {
        const res  = await fetch('/api/locations/bulk', { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Error al procesar');
        if (bar) bar.style.width = '100%';
        if (result) {
            result.textContent = `✓ ${data.updated} producto(s) actualizados de ${data.total} en el archivo.`;
            result.className = 'text-sm text-center font-semibold rounded-xl py-2 px-3 bg-green-50 text-green-700';
            result.classList.remove('hidden');
        }
        prog?.classList.add('hidden');
    } catch (e) {
        if (bar) bar.style.width = '0%';
        prog?.classList.add('hidden');
        if (result) {
            result.textContent = `Error: ${e.message}`;
            result.className = 'text-sm text-center font-semibold rounded-xl py-2 px-3 bg-red-50 text-red-700';
            result.classList.remove('hidden');
        }
    } finally {
        if (btn) btn.disabled = false;
    }
}

// Iniciar
init();
