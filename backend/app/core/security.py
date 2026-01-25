import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.core.config import get_settings
from app.services.errors import DomainError

logger = logging.getLogger(__name__)


def install_exception_handlers(app: FastAPI) -> None:
    """Ensure error responses never leak internals (stack traces, exception
    text) to the client, especially in production."""

    @app.exception_handler(DomainError)
    async def domain_error_handler(_request: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"status": "error", "message": str(exc)},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={
                "status": "error",
                "message": "Invalid request",
                "errors": jsonable_encoder(exc.errors()),
            },
        )

    @app.exception_handler(HTTPException)
    async def http_exception_handler(_request: Request, exc: HTTPException) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"status": "error", "message": exc.detail},
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(_request: Request, exc: Exception) -> JSONResponse:
        settings = get_settings()
        logger.exception("Unhandled exception while processing request")
        message = str(exc) if not settings.is_production else "Internal server error"
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": message},
        )
