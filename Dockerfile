FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/
COPY version.json .

# Directorio persistente para la base de datos SQLite
RUN mkdir -p /data

ENV DATABASE_PATH=/data/mirastock.db

EXPOSE 8001

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
