from fastapi import APIRouter

from app.rag.quote_search import search
from app.schemas.quote import Extraction
from app.tools.quote.normalize import normalize
from app.tools.quote.parse import parse
from app.tools.quote.requirements import requirements

router = APIRouter(prefix="/tools/quote", tags=["quote"])
router.post("/parse", response_model=Extraction)(parse)
router.post("/normalize")(normalize)
router.post("/requirements")(requirements)
router.post("/search")(search)
