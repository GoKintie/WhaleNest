FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py idmap.py media_auth.py msgs.py onebot.py ./
COPY drivers/ ./drivers/
COPY voice/ ./voice/

RUN mkdir -p /app/data && useradd -m -u 1000 bot && chown -R bot:bot /app
USER bot

EXPOSE 3001

CMD ["python", "main.py", "config.toml"]
