import os
import unicodedata
from fastapi import APIRouter, BackgroundTasks, HTTPException

from app.database import get_db, DB_PATH
from app.sap_sync_worker import sync_status, start_async_sync

router = APIRouter(prefix="/api", tags=["Catalog"])

WAREHOUSES = ["01", "11", "15", "30"]

_PRODUCT_COLS = """
    p.sku,
    p.name,
    p.item_type,
    p.price,
    p.image_url,
    COALESCE(s01.on_hand, 0) AS stock_01,
    COALESCE(s11.on_hand, 0) AS stock_11,
    COALESCE(s15.on_hand, 0) AS stock_15,
    COALESCE(s30.on_hand, 0) AS stock_30,
    (COALESCE(s01.on_hand, 0) + COALESCE(s11.on_hand, 0) +
     COALESCE(s15.on_hand, 0) + COALESCE(s30.on_hand, 0)) AS total_stock
"""

_JOINS = """
    FROM products p
    LEFT JOIN stock s01 ON p.sku = s01.sku AND s01.warehouse_code = '01'
    LEFT JOIN stock s11 ON p.sku = s11.sku AND s11.warehouse_code = '11'
    LEFT JOIN stock s15 ON p.sku = s15.sku AND s15.warehouse_code = '15'
    LEFT JOIN stock s30 ON p.sku = s30.sku AND s30.warehouse_code = '30'
"""


def _normalize(text: str) -> str:
    if not text:
        return ""
    return "".join(
        c for c in unicodedata.normalize("NFD", str(text)) if unicodedata.category(c) != "Mn"
    ).lower()


def _build_conditions(search: str, item_type: str, stock_filter: str, warehouse: str):
    conditions, args = [], []

    if search:
        norm = _normalize(search)
        conditions.append("(p.name_norm LIKE ? OR LOWER(p.sku) LIKE ?)")
        args.extend([f"%{norm}%", f"%{norm}%"])

    if item_type and item_type != "all":
        conditions.append("p.item_type = ?")
        args.append(item_type)

    total_expr = (
        "COALESCE(s01.on_hand,0)+COALESCE(s11.on_hand,0)+"
        "COALESCE(s15.on_hand,0)+COALESCE(s30.on_hand,0)"
    )
    if stock_filter == "instock":
        conditions.append(f"({total_expr}) > 0")
    elif stock_filter == "outofstock":
        conditions.append(f"({total_expr}) = 0")

    whs_alias = {"01": "s01", "11": "s11", "15": "s15", "30": "s30"}
    if warehouse and warehouse in whs_alias:
        conditions.append(f"COALESCE({whs_alias[warehouse]}.on_hand, 0) > 0")

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    return where, args


@router.get("/products")
async def get_products(
    search: str = "",
    item_type: str = "all",
    stock_filter: str = "all",
    warehouse: str = "all",
    page: int = 1,
    page_size: int = 24,
):
    if not os.path.exists(DB_PATH):
        return {
            "products": [],
            "pagination": {"current_page": 1, "total_pages": 0, "total_items": 0, "page_size": page_size},
        }

    where, args = _build_conditions(search, item_type, stock_filter, warehouse)

    conn = get_db()
    total_items = conn.execute(f"SELECT COUNT(*) {_JOINS} {where}", args).fetchone()[0]
    total_pages = max(1, (total_items + page_size - 1) // page_size)
    page = max(1, min(page, total_pages))
    offset = (page - 1) * page_size

    rows = conn.execute(
        f"SELECT {_PRODUCT_COLS} {_JOINS} {where} ORDER BY p.name LIMIT ? OFFSET ?",
        args + [page_size, offset],
    ).fetchall()
    conn.close()

    return {
        "products": [dict(r) for r in rows],
        "pagination": {
            "current_page": page,
            "total_pages": total_pages,
            "total_items": total_items,
            "page_size": page_size,
        },
    }


@router.get("/product/{sku}")
async def get_product(sku: str):
    if not os.path.exists(DB_PATH):
        raise HTTPException(
            status_code=503,
            detail="Base de datos no inicializada. Ejecute una sincronización primero.",
        )

    conn = get_db()
    row = conn.execute(
        f"SELECT {_PRODUCT_COLS} {_JOINS} WHERE UPPER(p.sku) = UPPER(?)",
        (sku.strip(),),
    ).fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail=f"Producto con SKU '{sku}' no encontrado.")

    return {"status": "success", "product": dict(row)}


@router.get("/sync-status")
async def get_sync_status():
    return sync_status


@router.post("/trigger-sync")
async def trigger_sync(background_tasks: BackgroundTasks):
    if sync_status["is_running"]:
        return {"message": "Sincronización ya en curso.", "status": sync_status}
    background_tasks.add_task(start_async_sync)
    return {"message": "Sincronización iniciada.", "status": sync_status}


@router.get("/sync-schedule")
async def get_sync_schedule():
    from app.main import scheduler, SYNC_INTERVAL_MINUTES
    job = scheduler.get_job("auto_sync")
    next_run = (
        job.next_run_time.strftime("%Y-%m-%d %H:%M:%S") if job and job.next_run_time else None
    )
    return {"interval_minutes": SYNC_INTERVAL_MINUTES, "next_sync": next_run}
