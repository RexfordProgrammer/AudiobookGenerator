
import sys
import os
# Import the real parser from the parent backend directory
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import parser as _parent_parser  # noqa: E402 (must come after sys.path insert)


# from parser import extract_text

if __name__ == "__main__":
    text = _parent_parser.extract_text("destunknown.epub")
    print(text)
