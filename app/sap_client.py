import os
import logging
import time
from datetime import datetime, timedelta

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

logger = logging.getLogger("SAPClient")


class SAPClient:
    """Cliente singleton para SAP Service Layer con persistencia de sesión en memoria."""

    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return

        from requests.adapters import HTTPAdapter
        from urllib3.util.retry import Retry

        self.base_url = os.getenv("SAP_BASE_URL", "").rstrip("/")
        self.db = os.getenv("SAP_DB", "")
        self.user = os.getenv("SAP_USER", "")
        self.password = os.getenv("SAP_PASSWORD", "")
        self.timeout = int(os.getenv("SAP_TIMEOUT", "120"))
        self.retries = int(os.getenv("SAP_RETRIES", "5"))

        self.session = requests.Session()
        self.session.verify = False

        retry = Retry(
            total=self.retries,
            backoff_factor=1,
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["HEAD", "GET", "OPTIONS", "POST"],
        )
        adapter = HTTPAdapter(max_retries=retry, pool_connections=10, pool_maxsize=20)
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)

        self.session_token = None
        self.last_login = None
        self.session_lifetime = timedelta(minutes=25)
        self._initialized = True
        logger.info("SAPClient inicializado.")

    def _session_valid(self):
        return (
            self.session_token
            and self.last_login
            and datetime.now() - self.last_login < self.session_lifetime
        )

    def login(self) -> bool:
        if self._session_valid():
            return True
        logger.info("Iniciando sesión en SAP Service Layer...")
        try:
            r = self.session.post(
                f"{self.base_url}/Login",
                json={"CompanyDB": self.db, "UserName": self.user, "Password": self.password},
                timeout=60,
            )
            r.raise_for_status()
            self.session_token = self.session.cookies.get("B1SESSION")
            self.last_login = datetime.now()
            logger.info("Sesión SAP establecida.")
            return True
        except Exception as e:
            logger.error(f"Error en login SAP: {e}")
            return False

    def get(self, endpoint: str, params=None) -> dict:
        url = endpoint if endpoint.startswith("http") else f"{self.base_url}/{endpoint.lstrip('/')}"
        for attempt in range(self.retries):
            try:
                if not self.login():
                    raise RuntimeError("No se pudo autenticar con SAP.")
                r = self.session.get(url, params=params, timeout=self.timeout)
                if r.status_code == 401:
                    logger.warning("Sesión expirada (401). Forzando re-login...")
                    self.session_token = None
                    if self.login():
                        r = self.session.get(url, params=params, timeout=self.timeout)
                r.raise_for_status()
                return r.json()
            except (requests.ConnectionError, requests.Timeout) as e:
                if attempt == self.retries - 1:
                    raise
                wait = 3 * (2 ** attempt)
                logger.warning(f"Error de red (intento {attempt + 1}): {e}. Reintentando en {wait}s...")
                time.sleep(wait)

    def get_all_pages(self, endpoint: str, params: dict = None, page_size: int = 200) -> list:
        """Itera páginas OData ($skiptoken / odata.nextLink) y acumula todos los registros."""
        if params is None:
            params = {}
        params.setdefault("$top", page_size)

        results = []
        current = endpoint
        page = 1

        while current:
            data = self.get(current, params=params if page == 1 else None)
            if isinstance(data, list):
                results.extend(data)
                current = None
            elif isinstance(data, dict):
                batch = data.get("value", [])
                results.extend(batch)
                logger.info(
                    f"[SAP] {endpoint}: página {page} — {len(batch)} registros (total: {len(results)})"
                )
                nxt = data.get("@odata.nextLink") or data.get("odata.nextLink")
                if nxt:
                    current = nxt if nxt.startswith("http") else f"{endpoint.split('?')[0]}?{nxt.split('?')[-1]}"
                else:
                    current = None
            else:
                current = None
            page += 1

        logger.info(f"[SAP] {endpoint}: {len(results)} registros totales en {page - 1} página(s).")
        return results
