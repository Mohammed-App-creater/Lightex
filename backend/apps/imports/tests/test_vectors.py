"""Board 40 parser, matching and conversion against the shared vectors (tests/data/import_vectors.json, the same
file the web client's mock tests read), plus the Jira fixture's encoding/delimiter variants."""

import pytest

from apps.common import fractional
from apps.common.csvsafe import csv_document, csv_line, csv_safe
from apps.imports import mapping, parsing, presets
from apps.imports.report import build_report, report_file_name

from .fixtures import JIRA, SAMPLE, VECTORS, sample_text


def _parse(text: str) -> parsing.ParsedFile:
    return parsing.parse_csv(text, parsing.sniff_delimiter(text), 5000)


@pytest.mark.parametrize("v", VECTORS["decode"], ids=lambda v: v["name"])
def test_decode(v):
    data = bytes.fromhex(v["hex"])
    if "error" in v:
        with pytest.raises(parsing.ParseError) as exc:
            parsing.decode_bytes(data)
        assert exc.value.reason == v["error"]
    else:
        assert parsing.decode_bytes(data) == (v["text"], v["encoding"])


@pytest.mark.parametrize("v", VECTORS["delimiter"], ids=lambda v: v["name"])
def test_delimiter(v):
    assert parsing.sniff_delimiter(v["text"]) == v["delimiter"]


@pytest.mark.parametrize("v", VECTORS["parse"], ids=lambda v: v["name"])
def test_parse(v):
    if "error" in v:
        with pytest.raises(parsing.ParseError) as exc:
            parsing.parse_csv(v["text"], v["delimiter"], 1000)
        assert exc.value.as_dict() == v["error"]
    else:
        parsed = parsing.parse_csv(v["text"], v["delimiter"], 1000)
        assert parsed.header == v["header"]
        assert parsed.rows == v["rows"]


def test_parse_limits():
    rows = "\n".join(f"Task {i}" for i in range(1240))
    with pytest.raises(parsing.ParseError) as exc:
        parsing.parse_csv(f"Title\n{rows}\n", ",", 1000)
    assert exc.value.as_dict() == {"reason": "too_many_rows", "rows": 1240, "max": 1000}
    wide = ",".join(f"C{i}" for i in range(45))
    with pytest.raises(parsing.ParseError) as exc:
        parsing.parse_csv(f"{wide}\nx\n", ",", 1000)
    assert exc.value.as_dict() == {"reason": "too_many_columns", "columns": 45, "max": 40}
    long = "x" * 65_537
    with pytest.raises(parsing.ParseError) as exc:
        parsing.parse_csv(f"Title\nok\n{long}\n", ",", 1000)
    assert exc.value.as_dict() == {"reason": "cell_too_long", "line": 3}


def test_lenient_text_after_a_closing_quote_and_quoted_line_counting():
    parsed = parsing.parse_csv('A,B\n"ab"c,"x\r\ny"\n"q",\n', ",", 10)
    assert parsed.rows == [["abc", "x\ny"], ["q", ""]]  # CR is a C0 control character: stripped
    with pytest.raises(parsing.ParseError) as exc:
        parsing.parse_csv('A,B\n"multi\nline",ok\n"open\n', ",", 10)
    assert exc.value.as_dict() == {"reason": "unclosed_quote", "line": 4}


def test_jira_fixture_variants_read_identically():
    text = JIRA.decode()
    base = _parse(text)
    assert base.delimiter == ","
    assert len(base.rows) == 6

    cp1252 = text.replace("Cart drawer,", "Café drawer,").encode("cp1252")
    decoded, encoding = parsing.decode_bytes(cp1252)
    assert encoding == "windows-1252"
    assert _parse(decoded).rows[1][2] == "Café drawer"

    decoded, encoding = parsing.decode_bytes(b"\xef\xbb\xbf" + JIRA)
    assert encoding == "utf-8"
    assert _parse(decoded).rows == base.rows

    semi = "\r\n".join(line.replace(",", ";") for line in text.split("\n"))
    parsed = _parse(semi)
    assert parsed.delimiter == ";"
    assert parsed.rows == base.rows

    lf = text.replace("\r\n", "\n")
    assert _parse(lf.replace("\n", "\r\n")).rows == base.rows

    tab = text.replace(",", "\t")
    decoded, encoding = parsing.decode_bytes(b"\xff\xfe" + tab.encode("utf-16-le"))
    assert encoding == "utf-16"
    parsed = _parse(decoded)
    assert parsed.delimiter == "\t"
    assert parsed.rows == base.rows

    quoted = text.replace("Payment retry", '"Payment\nretry"')
    assert _parse(quoted).rows[4][2] == "Payment\nretry"


def test_read_file_errors():
    with pytest.raises(parsing.ParseError) as exc:
        parsing.read_file(b"", 10)
    assert exc.value.reason == "empty"
    parsed, encoding = parsing.read_file(b"Title\nA\n", 10)
    assert (parsed.rows, encoding) == ([["A"]], "utf-8")
    assert parsing.ParsedFile.from_json(parsed.to_json()) == parsed


@pytest.mark.parametrize("v", VECTORS["headers"], ids=lambda v: v["header"])
def test_headers(v):
    assert presets.norm_header(v["header"]) == v["normalised"]
    assert presets.field_for_header(v["header"]) == v["field"]


@pytest.mark.parametrize("v", VECTORS["presets"], ids=lambda v: v["preset"] + ":" + ",".join(v["headers"]))
def test_presets(v):
    assert presets.detect_preset(v["headers"]) == v["preset"]


@pytest.mark.parametrize("v", VECTORS["suggest"], ids=lambda v: v["name"])
def test_suggest(v):
    assert presets.suggest_columns(v["headers"], v["preset"], []) == v["columns"]


def test_suggest_custom_field_by_name():
    assert presets.suggest_columns(["Title", "Browser", "browser"], "generic", [{"id": "cf1", "name": "Browser"}]) == [
        {"field": "title"},
        {"field": "customField", "customFieldId": "cf1"},
        {"field": "skip"},
    ]


@pytest.mark.parametrize("c", VECTORS["statuses"]["cases"], ids=lambda c: c["value"])
def test_statuses(c):
    assert mapping.match_status(c["value"], VECTORS["statuses"]["project"]) == c["target"]


@pytest.mark.parametrize("c", VECTORS["types"], ids=lambda c: f"{c['value']}-{c['canEpic']}")
def test_types(c):
    assert mapping.match_type(c["value"], c["canEpic"]) == c["type"]


@pytest.mark.parametrize("c", VECTORS["people"]["cases"], ids=lambda c: c["value"] or "empty")
def test_people(c):
    assert mapping.match_person(c["value"], VECTORS["people"]["members"]) == (c["target"], c["matchedBy"])


@pytest.mark.parametrize("c", VECTORS["priorities"], ids=lambda c: c["value"] or "empty")
def test_priorities(c):
    assert mapping.match_priority(c["value"]) == c["priority"]


@pytest.mark.parametrize("c", VECTORS["dates"], ids=lambda c: f"{c['value']}-{c['order']}")
def test_dates(c):
    assert mapping.parse_date(c["value"], c["order"]) == c["date"]


@pytest.mark.parametrize("c", VECTORS["dateOrder"], ids=lambda c: "|".join(c["values"]))
def test_date_order(c):
    assert mapping.date_order_of(c["values"]) == c["order"]


@pytest.mark.parametrize("c", VECTORS["numbers"], ids=lambda c: f"{c['value']}-{c['delimiter']}")
def test_numbers(c):
    assert mapping.parse_number(c["value"], c["delimiter"]) == c["number"]


@pytest.mark.parametrize("c", VECTORS["durations"], ids=lambda c: f"{c['value']}-{c['unit']}")
def test_durations(c):
    assert mapping.parse_duration_cell(c["value"], c["unit"]) == c["minutes"]


def test_more_conversions():
    assert mapping.parse_duration("") is None
    assert mapping.parse_duration("45") == 45
    assert mapping.parse_duration("1h") == 60
    assert mapping.parse_duration_cell("-3", "hours") is None
    assert mapping.parse_date("Sept 3, 2026") == "2026-09-03"
    assert mapping.parse_date("3 Foo 2026") is None
    assert mapping.parse_date("Foo 3, 2026") is None
    assert mapping.parse_date("31/Foo/26") is None
    assert mapping.parse_date("14/10/2026") is None  # mdy by default: month 14 doesn't exist
    assert mapping.iso_of(999, 1, 1) is None
    assert mapping.parse_number("1 240.5") == 1240.5
    assert mapping.round_half_up(2.5) == 3
    names = {"alex kim"}
    assert mapping.infer_type(["", " "], names) == "empty"
    assert mapping.infer_type(["1", "2,000"], names) == "number"
    assert mapping.infer_type(["2026-10-01", "Oct 2, 2026"], names) == "date"
    assert mapping.infer_type(["1h 30m", "2h"], names) == "duration"
    assert mapping.infer_type(["a@b.co", "Alex Kim"], names) == "person"
    assert mapping.infer_type(["a;b", "c", "d"], names) == "list"
    assert mapping.infer_type(["hello", "world"], names) == "text"


@pytest.mark.parametrize("c", VECTORS["csvSafe"], ids=lambda c: repr(c["value"]))
def test_csv_safe(c):
    assert csv_safe(c["value"]) == c["cell"]


def test_csv_helpers_and_report():
    assert csv_safe(None) == '""'
    assert csv_line([1, "=x"]) == '"1","\'=x"'
    assert csv_document([["a"], ["b"]]) == '﻿"a"\r\n"b"\r\n'
    assert csv_document([["a"]], bom=False) == '"a"\r\n'
    report = build_report(
        ["Title", "=Due"],
        [["=cmd|' /C calc'!A0", "next week"], ["Ok", "2026-10-08"]],
        [
            {"row": 3, "severity": "warning", "field": "sprint",
             "reason": "No sprint named “S9” · added to the backlog", "value": "S9"},
            {"row": 2, "severity": "skip", "field": "dueDate", "reason": "Invalid due date", "value": "next week"},
            {"row": 2, "severity": "skip", "field": "dueDate", "reason": "Invalid due date", "value": "next week"},
        ],
    )  # fmt: skip
    assert report.split("\r\n") == [
        '﻿"Row","Outcome","Reason","Value","Title","\'=Due"',
        '"2","Skipped","Invalid due date","next week","\'=cmd|\' /C calc\'!A0","next week"',
        '"3","Imported with changes","No sprint named “S9” · added to the backlog","S9","Ok","2026-10-08"',
        "",
    ]
    import datetime as dt

    assert report_file_name("PRJ", dt.datetime(2026, 10, 9, 23, 0, tzinfo=dt.UTC)) == "import-errors-prj-2026-10-09.csv"


def test_keys_after_stays_short_and_ordered():
    keys = fractional.keys_after(None, 200)
    assert keys == sorted(keys) and len(set(keys)) == 200
    last = keys[-1]
    for _ in range(25):  # 25 batches of 200 appended to one column
        more = fractional.keys_after(last, 200)
        assert more == sorted(more) and more[0] > last
        assert all(fractional.is_valid_key(k) for k in more)
        last = more[-1]
    assert len(last) <= 6
    assert fractional.keys_after("z", 0) == []
    assert fractional.keys_after("zzz", 1)[0] > "zzz"


def test_sample_fixture_matches_the_port():
    assert sample_text().encode() == SAMPLE
    parsed = _parse(SAMPLE.decode())
    assert len(parsed.rows) == 48 and parsed.rows[6][0] == "" and parsed.rows[18][6] == "next week"
