#!/usr/bin/env python3
"""
Exporta imágenes de productos desde WooCommerce a Google Drive.

Nomenclatura:
  - 1 imagen  →  SKU.jpg
  - N imágenes →  SKU-1.jpg, SKU-2.jpg, ...

Uso:
    python scripts/export_images_to_drive.py

Variables de entorno (.env):
    GDRIVE_CREDENTIALS_JSON_B64  — Service Account JSON codificado en base64
    GDRIVE_FOLDER_ID             — (opcional) ID de carpeta Drive existente
    GDRIVE_FOLDER_NAME           — nombre de la carpeta a crear si no hay ID
    WOO_URL, WOO_KEY, WOO_SECRET

Tras completar, actualiza image_url en la DB local con la URL de Drive.
"""

import base64
import io
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload
from requests_oauthlib import OAuth1

# Carga .env desde la raíz del proyecto
load_dotenv(Path(__file__).parent.parent / ".env")

SCOPES = ["https://www.googleapis.com/auth/drive"]
FOLDER_NAME = os.getenv("GDRIVE_FOLDER_NAME", "MiraStock Imágenes")


# ── Helpers ────────────────────────────────────────────────────────────────────

def _ext(url: str, content_type: str = "") -> str:
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
        return ".jpg" if suffix == ".jpeg" else suffix
    ct_map = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
    }
    return ct_map.get(content_type.split(";")[0].strip(), ".jpg")


def drive_view_url(file_id: str) -> str:
    return f"https://drive.google.com/thumbnail?id={file_id}&sz=w600"


# ── Google Drive ───────────────────────────────────────────────────────────────

def build_service():
    b64 = os.getenv("GDRIVE_CREDENTIALS_JSON_B64", "")
    if not b64:
        print("ERROR: GDRIVE_CREDENTIALS_JSON_B64 no está configurado en .env")
        sys.exit(1)
    try:
        info = json.loads(base64.b64decode(b64).decode("utf-8"))
    except Exception as e:
        print(f"ERROR: No se pudo decodificar GDRIVE_CREDENTIALS_JSON_B64: {e}")
        sys.exit(1)
    creds = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def resolve_folder(svc, folder_id: str) -> str:
    if folder_id:
        print(f"  Usando carpeta existente: {folder_id}")
        return folder_id

    q = (
        f"name='{FOLDER_NAME}' and "
        "mimeType='application/vnd.google-apps.folder' and trashed=false"
    )
    res = svc.files().list(
        q=q,
        fields="files(id,name)",
        supportsAllDrives=True,
        includeItemsFromAllDrives=True,
    ).execute()
    if res["files"]:
        fid = res["files"][0]["id"]
        print(f"  Carpeta encontrada: '{FOLDER_NAME}' ({fid})")
        return fid

    folder = svc.files().create(
        body={"name": FOLDER_NAME, "mimeType": "application/vnd.google-apps.folder"},
        fields="id",
        supportsAllDrives=True,
    ).execute()
    fid = folder["id"]
    svc.permissions().create(
        fileId=fid,
        body={"type": "anyone", "role": "reader"},
        supportsAllDrives=True,
    ).execute()
    print(f"  Carpeta creada: '{FOLDER_NAME}' ({fid})")
    print(f"\n  Agrega esta línea a tu .env para reutilizarla:\n  GDRIVE_FOLDER_ID={fid}\n")
    return fid


def list_existing(svc, folder_id: str) -> set[str]:
    names: set[str] = set()
    page_token = None
    while True:
        res = svc.files().list(
            q=f"'{folder_id}' in parents and trashed=false",
            fields="nextPageToken, files(name)",
            pageToken=page_token,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        ).execute()
        names.update(f["name"] for f in res.get("files", []))
        page_token = res.get("nextPageToken")
        if not page_token:
            break
    return names


def upload_file(svc, folder_id: str, filename: str, data: bytes, mime: str) -> str:
    media = MediaIoBaseUpload(io.BytesIO(data), mimetype=mime)
    f = svc.files().create(
        body={"name": filename, "parents": [folder_id]},
        media_body=media,
        fields="id",
        supportsAllDrives=True,
    ).execute()
    svc.permissions().create(
        fileId=f["id"],
        body={"type": "anyone", "role": "reader"},
        supportsAllDrives=True,
    ).execute()
    return f["id"]


# ── WooCommerce ────────────────────────────────────────────────────────────────

def fetch_all_images() -> dict[str, list[str]]:
    """Retorna {SKU_UPPER: [url1, url2, ...]} para todos los productos y variaciones."""
    woo_url = os.getenv("WOO_URL", "").rstrip("/")
    key     = os.getenv("WOO_KEY", "")
    secret  = os.getenv("WOO_SECRET", "")
    if not (woo_url and key and secret):
        print("ERROR: WOO_URL, WOO_KEY y WOO_SECRET son requeridos en .env")
        sys.exit(1)

    auth = OAuth1(key, secret)
    base = f"{woo_url}/wp-json/wc/v3"
    sku_images: dict[str, list[str]] = {}
    variable_ids: list[int] = []
    page = 1

    print("  Descargando productos de WooCommerce...")
    while True:
        r = requests.get(
            f"{base}/products",
            auth=auth,
            params={"page": page, "per_page": 100, "_fields": "id,sku,type,images"},
            timeout=30,
        )
        r.raise_for_status()
        products = r.json()
        if not products:
            break
        for p in products:
            sku  = str(p.get("sku") or "").strip().upper()
            imgs = [img["src"] for img in (p.get("images") or []) if img.get("src")]
            if sku and imgs:
                sku_images[sku] = imgs
            if p.get("type") == "variable":
                variable_ids.append(p["id"])
        print(f"    Página {page}: {len(products)} productos")
        page += 1

    if variable_ids:
        print(f"  Obteniendo variaciones de {len(variable_ids)} productos variables...")
        for pid in variable_ids:
            vpage = 1
            while True:
                r = requests.get(
                    f"{base}/products/{pid}/variations",
                    auth=auth,
                    params={"per_page": 100, "page": vpage, "_fields": "sku,image"},
                    timeout=30,
                )
                r.raise_for_status()
                variations = r.json()
                if not variations:
                    break
                for v in variations:
                    vsku = str(v.get("sku") or "").strip().upper()
                    vimg = (v.get("image") or {}).get("src", "")
                    if vsku and vimg and vsku not in sku_images:
                        sku_images[vsku] = [vimg]
                vpage += 1

    return sku_images


# ── DB update ──────────────────────────────────────────────────────────────────

def update_db(sku_file_ids: dict[str, list[str]]) -> int:
    sys.path.insert(0, str(Path(__file__).parent.parent))
    from app.database import get_db  # noqa: E402 — importación tardía intencional

    conn = get_db()
    with conn:
        conn.executemany(
            "UPDATE products SET images=? WHERE sku=?",
            [(",".join(ids), sku) for sku, ids in sku_file_ids.items()],
        )
    conn.close()
    return len(sku_file_ids)


# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    print("=== MiraStock: Exportar imágenes a Google Drive ===\n")

    # 1. Drive
    svc = build_service()
    print("Verificando carpeta en Drive...")
    folder_id = resolve_folder(svc, os.getenv("GDRIVE_FOLDER_ID", ""))

    # 2. WooCommerce
    print("\nObteniendo catálogo de imágenes desde WooCommerce...")
    sku_images = fetch_all_images()
    total_imgs = sum(len(v) for v in sku_images.values())
    print(f"  {len(sku_images)} SKUs — {total_imgs} imágenes en total\n")

    # 3. Archivos ya subidos (para no duplicar)
    print("Revisando archivos ya existentes en Drive...")
    uploaded = list_existing(svc, folder_id)
    print(f"  {len(uploaded)} archivos previos encontrados\n")

    # 4. Subir
    sku_file_ids: dict[str, list[str]] = {}
    errors: list[str] = []
    new_files = 0

    for i, (sku, img_urls) in enumerate(sku_images.items(), 1):
        multiple = len(img_urls) > 1
        label    = f"{len(img_urls)} imgs" if multiple else "1 img"
        print(f"[{i}/{len(sku_images)}] {sku}  ({label})")

        ids_for_sku: list[str] = []
        for idx, img_url in enumerate(img_urls):
            mime = "image/jpeg"
            try:
                r    = requests.get(img_url, timeout=20)
                r.raise_for_status()
                mime = r.headers.get("content-type", "image/jpeg").split(";")[0].strip()
                ext  = _ext(img_url, mime)
                fname = f"{sku}-{idx + 1}{ext}" if multiple else f"{sku}{ext}"

                if fname in uploaded:
                    print(f"  — {fname} ya existe, omitido")
                    continue

                file_id = upload_file(svc, folder_id, fname, r.content, mime)
                uploaded.add(fname)
                ids_for_sku.append(file_id)
                new_files += 1
                print(f"  ✓ {fname}")

            except Exception as e:
                errors.append(f"{sku} img[{idx + 1}]: {e}")
                print(f"  ✗ {e}")

        if ids_for_sku:
            sku_file_ids[sku] = ids_for_sku

    # 5. Actualizar DB con IDs de Drive
    if sku_file_ids:
        print(f"\nActualizando base de datos local ({len(sku_file_ids)} SKUs)...")
        updated = update_db(sku_file_ids)
        print(f"  {updated} registros actualizados.")

    # 6. Resumen
    print(f"\n{'=' * 55}")
    print(f"Completado: {new_files} archivos nuevos | {len(errors)} errores")
    print(f"Carpeta Drive: https://drive.google.com/drive/folders/{folder_id}")
    if errors:
        print("\nErrores:")
        for e in errors:
            print(f"  - {e}")


if __name__ == "__main__":
    main()
