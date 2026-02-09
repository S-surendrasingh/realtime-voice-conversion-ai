class DomainError(Exception):
    """A business-rule violation. Handled globally by app/core/security.py,
    which returns `status_code` (400 unless a subclass overrides it — e.g.
    an upstream AI-worker failure isn't the caller's fault, so it uses 502)."""

    status_code: int = 400
