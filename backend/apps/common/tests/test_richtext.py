import pytest

from apps.common.exceptions import ApiError
from apps.common.richtext import doc_text, mention_ids, plain_doc, sanitize_doc


def test_strips_unknown_nodes_marks_and_attrs():
    raw = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "attrs": {"onclick": "x"},
                "content": [
                    {"type": "text", "text": "hi", "marks": [{"type": "bold"}, {"type": "evil"}]},
                    {"type": "script", "content": [{"type": "text", "text": "alert(1)"}]},
                    {
                        "type": "text",
                        "text": "link",
                        "marks": [{"type": "link", "attrs": {"href": "javascript:alert(1)"}}],
                    },
                    {
                        "type": "text",
                        "text": "ok",
                        "marks": [{"type": "link", "attrs": {"href": "https://x.dev", "target": "_blank"}}],
                    },
                ],
            },
            {"type": "heading", "attrs": {"level": 9}, "content": [{"type": "text", "text": "H"}]},
            {"type": "codeBlock", "attrs": {"language": "<img>"}, "content": [{"type": "text", "text": "x"}]},
            {"type": "mention", "attrs": {}},
        ],
    }
    doc = sanitize_doc(raw)
    para = doc["content"][0]
    assert "attrs" not in para
    assert para["content"][0]["marks"] == [{"type": "bold"}]
    assert len(para["content"]) == 3  # script node dropped
    assert "marks" not in para["content"][1]  # unsafe link removed, text kept
    assert para["content"][2]["marks"] == [{"type": "link", "attrs": {"href": "https://x.dev"}}]
    assert doc["content"][1]["attrs"] == {"level": 4}
    assert "attrs" not in doc["content"][2]
    assert len(doc["content"]) == 3  # mention without id dropped


def test_null_and_invalid():
    assert sanitize_doc(None) is None
    with pytest.raises(ApiError):
        sanitize_doc(None, allow_null=False)
    with pytest.raises(ApiError):
        sanitize_doc({"type": "paragraph"})
    with pytest.raises(ApiError):
        sanitize_doc("<p>html</p>")
    with pytest.raises(ApiError):
        sanitize_doc({"type": "doc", "content": [{"type": "text", "text": "x" * 300_000}]})


def test_text_and_mentions():
    doc = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {"type": "text", "text": "Hey "},
                    {"type": "mention", "attrs": {"id": "u1", "label": "Sam"}},
                    {"type": "hardBreak"},
                    {"type": "mention", "attrs": {"id": "u1", "label": "Sam"}},
                ],
            }
        ],
    }
    assert doc_text(doc) == "Hey @Sam @Sam"
    assert doc_text(doc, mention_prefix=False) == "Hey Sam Sam"
    assert mention_ids(doc) == ["u1"]
    assert doc_text(None) == ""
    assert doc_text(plain_doc("a  b")) == "a b"
