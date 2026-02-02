import uuid

from sqlalchemy.orm import Session

from app.models.user import User


def get_or_create(db: Session, user_id: uuid.UUID) -> User:
    user = db.get(User, user_id)
    if user is not None:
        return user

    user = User(id=user_id)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user
