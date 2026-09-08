"""ETL layer for the fantasy hockey draft tool.

Responsibility split: this package only *reads* projection workbooks and emits a
normalized JSON blob. All valuation math (blending, scoring, VORP) lives in
board/valuation.js so there is exactly one implementation of it.
"""

__all__ = ["config", "names", "teams", "sources", "export"]
