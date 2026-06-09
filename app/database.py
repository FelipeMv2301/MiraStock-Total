import sqlite3
import os

DB_PATH = os.getenv(
    "DATABASE_PATH",
    os.path.join(os.path.dirname(os.path.dirname(__file__)), "mirastock.db"),
)


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS products (
            sku               TEXT PRIMARY KEY,
            name              TEXT NOT NULL,
            name_norm         TEXT NOT NULL DEFAULT '',
            item_type         TEXT NOT NULL DEFAULT 'Producto',
            price             REAL NOT NULL DEFAULT 0,
            images            TEXT NOT NULL DEFAULT '',
            description       TEXT NOT NULL DEFAULT '',
            sell_item         INTEGER NOT NULL DEFAULT 1,
            categories        TEXT NOT NULL DEFAULT '',
            woo_regular_price REAL NOT NULL DEFAULT 0,
            woo_sale_price    REAL NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS stock (
            sku            TEXT NOT NULL,
            warehouse_code TEXT NOT NULL,
            on_hand        REAL NOT NULL DEFAULT 0,
            PRIMARY KEY (sku, warehouse_code)
        );

        CREATE TABLE IF NOT EXISTS categories (
            slug TEXT PRIMARY KEY,
            name TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_products_name_norm ON products(name_norm);
        CREATE INDEX IF NOT EXISTS idx_stock_sku ON stock(sku);
    """)
    for migration in [
        "ALTER TABLE products ADD COLUMN image_url         TEXT    NOT NULL DEFAULT ''",
        "ALTER TABLE products ADD COLUMN description       TEXT    NOT NULL DEFAULT ''",
        "ALTER TABLE products ADD COLUMN sell_item         INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE products ADD COLUMN categories        TEXT    NOT NULL DEFAULT ''",
        "ALTER TABLE products ADD COLUMN woo_regular_price REAL    NOT NULL DEFAULT 0",
        "ALTER TABLE products ADD COLUMN woo_sale_price    REAL    NOT NULL DEFAULT 0",
        "ALTER TABLE products ADD COLUMN images            TEXT    NOT NULL DEFAULT ''",
        "ALTER TABLE products ADD COLUMN location TEXT NOT NULL DEFAULT ''",
    ]:
        try:
            conn.execute(migration)
            conn.commit()
        except Exception:
            pass
    conn.close()
