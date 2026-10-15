"""Every feature any v4 market declares is documented (modeling/v4/featdoc.py)."""

from modeling.v4 import featdoc


def test_no_feature_is_undocumented():
    rows = featdoc.dictionary()
    missing = [r["feature"] for r in rows if r["group"] == "undocumented"]
    assert not missing, missing
    assert all(r["meaning"] and r["as_of"] for r in rows)


def test_examples():
    assert featdoc.describe("bf_h_g15")["meaning"].startswith("hits per PA, last 15")
    assert featdoc.describe("rs_5")["meaning"].endswith("home run per PA")
    assert featdoc.describe("p_cnt_ball_rate")["group"] == "pitcher stuff"
