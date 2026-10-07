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
CMD ["sh", "-c", "python manage.py migrate --noinput && gunicorn config.wsgi:application --bind 0.0.0.0:${PORT:-8000} --workers ${WEB_CONCURRENCY:-3} --access-logfile -"]
