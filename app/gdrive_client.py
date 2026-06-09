import base64
import io
import json
import os

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload

SCOPES = ["https://www.googleapis.com/auth/drive"]


def get_service():
    b64 = os.getenv("GDRIVE_CREDENTIALS_JSON_B64", "")
    if not b64:
        raise RuntimeError("GDRIVE_CREDENTIALS_JSON_B64 no configurado")
    info = json.loads(base64.b64decode(b64).decode("utf-8"))
    creds = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def upload_image(svc, folder_id: str, filename: str, data: bytes, mime: str) -> str:
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


def delete_file(svc, file_id: str) -> None:
    try:
        svc.files().delete(fileId=file_id, supportsAllDrives=True).execute()
    except Exception:
        pass


def file_url(file_id: str) -> str:
    return f"https://drive.google.com/thumbnail?id={file_id}&sz=w600"


def ids_to_urls(images_str: str) -> list:
    if not images_str:
        return []
    return [file_url(fid.strip()) for fid in images_str.split(",") if fid.strip()]
