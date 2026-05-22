import logging
import threading
import unicodedata
from datetime import datetime

from app.database import get_db, init_db

logger = logging.getLogger("SAPSync")

WAREHOUSES = {"01", "11", "15", "30"}

sync_status = {
    "is_running": False,
    "progress": 0,
    "last_sync": None,
    "total_products": 0,
    "message": "Sin sincronizar. Presione el botón para iniciar.",
}


def _normalize(text: str) -> str:
    if not text:
        return ""
    return "".join(
        c for c in unicodedata.normalize("NFD", str(text)) if unicodedata.category(c) != "Mn"
    ).lower()


def run_sync():
    sync_status.update({"is_running": True, "progress": 5, "message": "Conectando con SAP..."})

    try:
        from app.sap_client import SAPClient
        client = SAPClient()

        # ── FASE 1: SAP ─────────────────────────────────────────────────────────
        sync_status.update({
            "progress": 10,
            "message": "Obteniendo catálogo desde SAP (puede tomar varios minutos)...",
        })

        items = client.get_all_pages(
            "Items",
            params={
                "$select": "ItemCode,ItemName,SalesItem",
                "$expand": (
                    "ItemWarehouseInfoCollection($select=WarehouseCode,InStock),"
                    "ItemPrices($select=PriceList,Price)"
                ),
            },
            page_size=100,
        )

        total = len(items)
        sync_status.update({"progress": 65, "message": f"Procesando {total} ítems SAP..."})
        logger.info(f"[Sync] {total} ítems recibidos desde SAP.")

        # sku → (name, name_norm, item_type, price)
        products_map: dict[str, tuple] = {}
        stock_rows: list[tuple] = []

        for item in items:
            sku = (item.get("ItemCode") or "").strip()
            if not sku:
                continue

            name = (item.get("ItemName") or "").strip()
            item_type = "Producto" if item.get("SalesItem") == "tYES" else "Material"
            name_norm = _normalize(name)

            price = 0.0
            for p in item.get("ItemPrices") or []:
                if p.get("PriceList") == 1:
                    price = float(p.get("Price") or 0)
                    break

            products_map[sku] = (name, name_norm, item_type, price)

            for wh in item.get("ItemWarehouseInfoCollection") or []:
                code = (wh.get("WarehouseCode") or "").strip()
                if code in WAREHOUSES:
                    stock_rows.append((sku, code, float(wh.get("InStock") or 0)))

        # ── FASE 2: WooCommerce (enriquecimiento de imágenes, opcional) ──────────
        image_map: dict[str, str] = {}
        try:
            from app.woo_client import WooImageClient
            woo = WooImageClient()
            if woo.is_configured():
                sync_status.update({
                    "progress": 70,
                    "message": "Obteniendo imágenes desde WooCommerce...",
                })
                image_map = woo.get_sku_image_map()
                logger.info(f"[Sync] {len(image_map)} imágenes obtenidas de WooCommerce.")
            else:
                logger.info("[Sync] WooCommerce no configurado — se omite enriquecimiento de imágenes.")
        except Exception as e:
            logger.warning(f"[Sync] Error al obtener imágenes de WooCommerce (no crítico): {e}")

        # ── FASE 3: Persistir en SQLite ─────────────────────────────────────────
        sync_status.update({"progress": 85, "message": "Guardando en base de datos local..."})

        matched = 0
        product_rows = []
        for sku, (name, name_norm, item_type, price) in products_map.items():
            image_url = image_map.get(sku, "")
            if image_url:
                matched += 1
            product_rows.append((sku, name, name_norm, item_type, price, image_url))

        init_db()
        conn = get_db()
        with conn:
            conn.execute("DELETE FROM stock")
            conn.execute("DELETE FROM products")
            conn.executemany(
                "INSERT INTO products (sku, name, name_norm, item_type, price, image_url) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                product_rows,
            )
            conn.executemany(
                "INSERT INTO stock (sku, warehouse_code, on_hand) VALUES (?, ?, ?)",
                stock_rows,
            )
        conn.close()

        img_msg = f", {matched} con imagen" if image_map else ""
        sync_status.update({
            "is_running": False,
            "progress": 100,
            "total_products": len(product_rows),
            "last_sync": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "message": (
                f"Completado: {len(product_rows)} productos{img_msg}, "
                f"{len(stock_rows)} registros de stock."
            ),
        })
        logger.info(
            f"[Sync] Completado: {len(product_rows)} productos{img_msg}, "
            f"{len(stock_rows)} registros de stock."
        )

    except Exception as e:
        sync_status.update({
            "is_running": False,
            "progress": 0,
            "message": f"Error en sincronización: {str(e)}",
        })
        logger.error(f"Error en sync: {e}", exc_info=True)


def start_async_sync():
    if sync_status["is_running"]:
        logger.info("Sync ya en curso, omitiendo.")
        return
    threading.Thread(target=run_sync, daemon=True).start()
