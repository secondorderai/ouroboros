"""Compatibility alias for the former Gemma-specific advisor module."""

import sys

from . import advisor as _advisor

sys.modules[__name__] = _advisor
