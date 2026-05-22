console.log("[MiraStock-Total] Sistema cargado.");

let inputBuffer = '';
let bufferTimeout = null;
let resetTimeout = null;
let resetInterval = null;
let syncInterval = null;
let lastKnownRunning = false;
let currentPage = 1;

// --- 1. Inicialización ---
async function init() {
    try {
        await startSyncPolling();
        await loadSyncSchedule();
        loadCatalog();

        const savedScale = parseFloat(localStorage.getItem('font-scale')) || 1.0;
        document.documentElement.style.fontSize = `${16 * savedScale}px`;
        document.documentElement.style.setProperty('--font-scale', savedScale);
    } catch (err) {
        console.error("Error en init:", err);
    }
}

// --- 2. Navegación ---
function toggleMobileMenu() {
    document.getElementById('secondary-nav')?.classList.toggle('mobile-open');
}

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
        showError('Error de red o servidor', sku);
        startResetTimer();
    }
}

function displayProduct(p) {
    showView('product-view');

    document.getElementById('product-sku').textContent  = p.sku || '';
    document.getElementById('product-name').textContent = p.name || 'Sin nombre';
    document.getElementById('product-price').textContent = formatPrice(p.price);

    const typeEl = document.getElementById('product-type-badge');
    typeEl.textContent = p.item_type || 'Producto';
    typeEl.className = `text-[10px] font-bold uppercase px-3 py-1 rounded-full ${
        p.item_type === 'Material' ? 'type-badge-material' : 'type-badge-producto'
    }`;

    const s01 = Math.round(p.stock_01 || 0);
    const s11 = Math.round(p.stock_11 || 0);
    const s15 = Math.round(p.stock_15 || 0);
    const s30 = Math.round(p.stock_30 || 0);
    const total = Math.round(p.total_stock || 0);

    document.getElementById('product-stock-01').textContent = s01;
    document.getElementById('product-stock-11').textContent = s11;
    document.getElementById('product-stock-15').textContent = s15;
    document.getElementById('product-stock-30').textContent = s30;
    document.getElementById('product-total-stock').textContent = total;

    // Actualizar header badges
    document.getElementById('hdr-01').textContent = s01;
    document.getElementById('hdr-11').textContent = s11;
    document.getElementById('hdr-15').textContent = s15;
    document.getElementById('hdr-30').textContent = s30;
}

// --- 4. Catálogo ---
async function loadCatalog(search = '', page = 1) {
    const grid     = document.getElementById('catalog-grid');
    const loading  = document.getElementById('catalog-loading');
    const empty    = document.getElementById('catalog-empty');
    const pagination = document.getElementById('pagination-controls');

    if (search === null) search = document.getElementById('catalog-search').value;

    grid.innerHTML = '';
    loading.classList.remove('hidden');
    empty.classList.add('hidden');
    pagination.innerHTML = '';

    try {
        const type    = document.getElementById('catalog-type').value;
        const stock   = document.getElementById('catalog-stock-status').value;
        const whs     = document.getElementById('catalog-warehouse').value;
        const url = `/api/products?search=${encodeURIComponent(search)}&item_type=${encodeURIComponent(type)}&stock_filter=${stock}&warehouse=${whs}&page=${page}`;
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

function renderCatalog(products) {
    const grid  = document.getElementById('catalog-grid');
    const empty = document.getElementById('catalog-empty');
    grid.innerHTML = '';

    if (!products.length) {
        empty.classList.remove('hidden');
        return;
    }

    products.forEach(p => {
        const s01 = Math.round(p.stock_01 || 0);
        const s11 = Math.round(p.stock_11 || 0);
        const s15 = Math.round(p.stock_15 || 0);
        const s30 = Math.round(p.stock_30 || 0);
        const total = Math.round(p.total_stock || 0);
        const hasStock = total > 0;

        const typeCls = p.item_type === 'Material' ? 'type-badge-material' : 'type-badge-producto';

        const card = document.createElement('div');
        card.className = 'product-card rounded-2xl border border-gray-100 overflow-hidden shadow-sm flex flex-col';
        card.innerHTML = `
            <div class="p-3 bg-gray-50 border-b border-gray-100 flex items-start justify-between gap-2">
                <div class="flex flex-col min-w-0">
                    <span class="text-[9px] font-bold text-gray-400 uppercase font-mono truncate">${p.sku}</span>
                    <span class="text-[9px] font-bold px-2 py-0.5 rounded-full mt-1 inline-block ${typeCls}">${p.item_type}</span>
                </div>
                <div class="flex flex-col gap-0.5 items-end shrink-0">
                    <div class="flex gap-0.5">
                        <span class="wh-tag wh-01"><span class="text-[7px]">B01</span>${s01}</span>
                        <span class="wh-tag wh-11"><span class="text-[7px]">B11</span>${s11}</span>
                    </div>
                    <div class="flex gap-0.5">
                        <span class="wh-tag wh-15"><span class="text-[7px]">B15</span>${s15}</span>
                        <span class="wh-tag wh-30"><span class="text-[7px]">B30</span>${s30}</span>
                    </div>
                </div>
            </div>
            <div class="p-4 flex-1 flex flex-col">
                <h3 class="font-bold text-gray-800 text-sm mb-3 line-clamp-2 leading-snug">${p.name}</h3>
                <div class="mt-auto flex items-center justify-between">
                    <div class="flex flex-col">
                        <span class="text-orange-600 font-extrabold">${formatPrice(p.price)}</span>
                        <span class="text-[9px] font-bold mt-0.5 ${hasStock ? 'text-green-600' : 'text-red-400'}">
                            Total: ${total} u.
                        </span>
                    </div>
                    <button class="text-xs bg-gray-100 hover:bg-orange-100 hover:text-orange-600 px-3 py-1.5 rounded-lg font-bold transition-colors">
                        Ver más
                    </button>
                </div>
            </div>
        `;
        card.onclick = () => openProductModal(p);
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

// --- 5. Filtros catálogo ---
let searchTimeout;
document.getElementById('catalog-search').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => loadCatalog(e.target.value, 1), 400);
});
document.getElementById('catalog-type').addEventListener('change', () =>
    loadCatalog(document.getElementById('catalog-search').value, 1));
document.getElementById('catalog-stock-status').addEventListener('change', () =>
    loadCatalog(document.getElementById('catalog-search').value, 1));
document.getElementById('catalog-warehouse').addEventListener('change', () =>
    loadCatalog(document.getElementById('catalog-search').value, 1));

// --- 6. Modal de detalle ---
function openProductModal(p) {
    const s01 = Math.round(p.stock_01 || 0);
    const s11 = Math.round(p.stock_11 || 0);
    const s15 = Math.round(p.stock_15 || 0);
    const s30 = Math.round(p.stock_30 || 0);
    const total = Math.round(p.total_stock || 0);

    document.getElementById('modal-sku').textContent   = p.sku;
    document.getElementById('modal-title').textContent = p.name;
    document.getElementById('modal-price').textContent = formatPrice(p.price);
    document.getElementById('modal-total-stock').textContent = total;

    const badge = document.getElementById('modal-type-badge');
    badge.textContent = p.item_type || 'Producto';
    badge.className = `text-[10px] font-bold uppercase px-3 py-1 rounded-full ${
        p.item_type === 'Material' ? 'type-badge-material' : 'type-badge-producto'
    }`;

    document.getElementById('modal-stock-01').textContent = s01;
    document.getElementById('modal-stock-11').textContent = s11;
    document.getElementById('modal-stock-15').textContent = s15;
    document.getElementById('modal-stock-30').textContent = s30;

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

// Iniciar
init();
