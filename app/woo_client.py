"""
Cliente ligero de WooCommerce para MiraStock-Total.
Solo obtiene SKU + primera imagen de cada producto (enriquecimiento de catálogo).
"""
import os
import logging
import requests
from requests_oauthlib import OAuth1

logger = logging.getLogger("WooClient")


class WooImageClient:
    def __init__(self):
        self.url    = os.getenv("WOO_URL", "").rstrip("/")
        self.key    = os.getenv("WOO_KEY", "")
        self.secret = os.getenv("WOO_SECRET", "")
        self.auth   = OAuth1(self.key, self.secret) if self.key and self.secret else None
        self.base   = f"{self.url}/wp-json/wc/v3"

    def is_configured(self) -> bool:
        return bool(self.url and self.key and self.secret)

    def get_sku_image_map(self) -> dict[str, str]:
        """
        Devuelve {sku_upper: primera_imagen_url} para todos los productos de WooCommerce.
        Solo descarga sku e images para minimizar el payload.
        """
        if not self.is_configured():
            logger.warning("WooCommerce no configurado — se omite enriquecimiento de imágenes.")
            return {}

        result = {}
        page = 1
        logger.info("[Woo] Descargando mapa SKU → imagen...")
        while True:
            try:
                r = requests.get(
                    f"{self.base}/products",
                    auth=self.auth,
                    params={"page": page, "per_page": 100, "_fields": "sku,images"},
                    timeout=30,
                )
                r.raise_for_status()
                products = r.json()
                if not products:
                    break
                for p in products:
                    sku = str(p.get("sku") or "").strip().upper()
                    if not sku:
                        continue
                    images = p.get("images") or []
                    if images:
                        result[sku] = images[0].get("src", "")
                logger.info(f"[Woo] Página {page} — {len(products)} productos (total mapeados: {len(result)})")
                page += 1
            except Exception as e:
                logger.error(f"[Woo] Error en página {page}: {e}")
                break

        logger.info(f"[Woo] Mapa completado: {len(result)} productos con imagen.")
        return result
