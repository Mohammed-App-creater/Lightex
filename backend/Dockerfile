# Lightex API image. Python 3.12 (the supported runtime), gunicorn + whitenoise.
FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends libpq5 \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-dev.txt ./
ARG INSTALL_DEV=false
RUN pip install -r requirements.txt \
 && if [ "$INSTALL_DEV" = "true" ]; then pip install -r requirements-dev.txt; fi

COPY . .

RUN DJANGO_SECRET_KEY=build-only DJANGO_ALLOWED_HOSTS=localhost DJANGO_SETTINGS_MODULE=config.settings.prod \
    python manage.py collectstatic --noinput

RUN useradd --create-home --uid 10001 app && chown -R app /app
USER app

EXPOSE 8000
ENV DJANGO_SETTINGS_MODULE=config.settings.prod
# gthread workers (board 33): each realtime stream holds one thread, never a whole process. Streams are capped per
# process below the thread count (SSE_MAX_STREAMS_PER_PROCESS < GUNICORN_THREADS), so API requests always have threads.
CMD ["sh", "-c", "python manage.py migrate --noinput && exec gunicorn config.wsgi:application --bind 0.0.0.0:${PORT:-8000} --workers ${WEB_CONCURRENCY:-2} --worker-class gthread --threads ${GUNICORN_THREADS:-24} --timeout 30 --graceful-timeout 10 --keep-alive 5 --config gunicorn.conf.py --access-logfile -"]
