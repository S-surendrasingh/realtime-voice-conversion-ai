import os
import shutil
import tempfile

os.environ["APP_ENV"] = "test"
os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+psycopg2://postgres:postgres@localhost:5432/voice_conversion_test",
)
os.environ["STORAGE_LOCAL_ROOT"] = tempfile.mkdtemp(prefix="voice-conversion-test-storage-")

import pytest  # noqa: E402
from sqlalchemy import event  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

import app.models  # noqa: E402, F401  (register models on Base.metadata)
from app.db.base import Base  # noqa: E402
from app.db.session import engine  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _database_schema():
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture(scope="session", autouse=True)
def _storage_dir_cleanup():
    yield
    shutil.rmtree(os.environ["STORAGE_LOCAL_ROOT"], ignore_errors=True)


@pytest.fixture
def db_session():
    """A DB session bound to a transaction that is rolled back after the test,
    so tests never leak state into each other even when the code under test
    calls session.commit()."""
    connection = engine.connect()
    transaction = connection.begin()
    session = Session(bind=connection)
    session.begin_nested()

    @event.listens_for(session, "after_transaction_end")
    def _restart_savepoint(sess: Session, trans) -> None:
        if trans.nested and not trans._parent.nested:
            sess.begin_nested()

    try:
        yield session
    finally:
        session.close()
        transaction.rollback()
        connection.close()
