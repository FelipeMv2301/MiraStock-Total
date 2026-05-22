import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "mirastock.db")


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS products (
            sku       TEXT PRIMARY KEY,
            name      TEXT NOT NULL,
            name_norm TEXT NOT NULL DEFAULT '',
            item_type TEXT NOT NULL DEFAULT 'Producto',
            price     REAL NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS stock (
            sku            TEXT NOT NULL,
            warehouse_code TEXT NOT NULL,
            on_hand        REAL NOT NULL DEFAULT 0,
            PRIMARY KEY (sku, warehouse_code)
        );

        CREATE INDEX IF NOT EXISTS idx_products_name_norm ON products(name_norm);
        CREATE INDEX IF NOT EXISTS idx_stock_sku ON stock(sku);
    """)
    conn.commit()
    conn.close()
