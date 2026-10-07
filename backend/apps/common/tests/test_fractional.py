import pytest

from apps.common.fractional import evenly_spaced, is_valid_key, key_between, keys_between

# Produced by the web client's src/lib/utils/fractional-index.ts (node), so both sides agree.
VECTORS = [
    [None, None, "V"],
    ["a", None, "n"],
    [None, "a", "I"],
    ["a", "b", "aV"],
    ["a", "a1", "a0V"],
    ["Zz", "a", "ZzV"],
    ["a1", "a2", "a1V"],
    ["V", "V1", "V0V"],
    ["1", None, "W"],
    ["xyz", "z", "y"],
    ["a", "az", "aV"],
    ["zz", None, "zzV"],
    [None, "1", "0V"],
]


@pytest.mark.parametrize(("a", "b", "expected"), VECTORS)
def test_matches_client_algorithm(a, b, expected):
    assert key_between(a, b) == expected


def test_chains_match_client():
    assert keys_between(None, None, 8) == ["V", "l", "t", "x", "z", "zV", "zl", "zt"]
    assert keys_between("a", "b", 6) == ["aV", "al", "at", "ax", "az", "azV"]


def test_rejects_bad_ranges():
    with pytest.raises(ValueError):
        key_between("b", "a")
    with pytest.raises(ValueError):
        key_between("a0", None)


def test_evenly_spaced_is_sorted_unique_and_valid():
    for n in (1, 5, 61, 62, 500):
        keys = evenly_spaced(n)
        assert len(keys) == n
        assert keys == sorted(keys)
        assert len(set(keys)) == n
        assert all(is_valid_key(k) for k in keys)
    assert evenly_spaced(0) == []


def test_is_valid_key():
    assert is_valid_key("aV")
    assert not is_valid_key("a0")
    assert not is_valid_key("a-b")
    assert not is_valid_key(5)
