import logging
import os
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse

router = APIRouter(prefix="/auth", tags=["Auth"])
logger = logging.getLogger("MiraStockAuth")

ALLOWED_DOMAIN = "bioquimica.cl"

_AUTH_URL     = "https://accounts.google.com/o/oauth2/v2/auth"
_TOKEN_URL    = "https://oauth2.googleapis.com/token"
_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"


def _base_url(request: Request) -> str:
    return os.getenv("APP_BASE_URL", str(request.base_url).rstrip("/"))


@router.get("/login")
async def login(request: Request):
    client_id = os.getenv("GOOGLE_CLIENT_ID", "")
    if not client_id:
        return JSONResponse({"error": "GOOGLE_CLIENT_ID no configurado en .env"}, status_code=500)
    params = {
        "client_id":     client_id,
        "redirect_uri":  f"{_base_url(request)}/auth/callback",
        "response_type": "code",
        "scope":         "openid email profile",
        "access_type":   "online",
        "prompt":        "select_account",
    }
    return RedirectResponse(f"{_AUTH_URL}?{urlencode(params)}")


@router.get("/callback")
async def callback(request: Request, code: str = "", error: str = ""):
    if error or not code:
        return RedirectResponse("/?auth_error=acceso_denegado")

    async with httpx.AsyncClient() as client:
        token_resp = await client.post(_TOKEN_URL, data={
            "code":          code,
            "client_id":     os.getenv("GOOGLE_CLIENT_ID", ""),
            "client_secret": os.getenv("GOOGLE_CLIENT_SECRET", ""),
            "redirect_uri":  f"{_base_url(request)}/auth/callback",
            "grant_type":    "authorization_code",
        })
        token_data  = token_resp.json()
        access_token = token_data.get("access_token")
        if not access_token:
            logger.error(f"[Auth] Token exchange failed: {token_data}")
            return RedirectResponse("/?auth_error=token_fallido")

        user_resp = await client.get(
            _USERINFO_URL,
            headers={"Authorization": f"Bearer {access_token}"},
        )
        info = user_resp.json()

    email = info.get("email", "")
    if not email.lower().endswith(f"@{ALLOWED_DOMAIN}"):
        logger.warning(f"[Auth] Dominio no permitido: {email}")
        return RedirectResponse("/?auth_error=dominio")

    request.session["user"] = {
        "email":   email,
        "name":    info.get("name", email),
        "picture": info.get("picture", ""),
    }
    logger.info(f"[Auth] Sesión iniciada: {email}")
    return RedirectResponse("/")


@router.get("/me")
async def me(request: Request):
    user = request.session.get("user")
    if not user:
        return JSONResponse({"authenticated": False, "user": None})
    return JSONResponse({"authenticated": True, "user": user})


@router.get("/logout")
async def logout(request: Request):
    email = (request.session.get("user") or {}).get("email", "anónimo")
    request.session.clear()
    logger.info(f"[Auth] Sesión cerrada: {email}")
    return RedirectResponse("/")
