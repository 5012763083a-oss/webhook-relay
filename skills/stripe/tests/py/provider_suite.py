"""Parametrised suite reused by every test_<provider>.py file."""
import pytest

from conftest import fresh_client, load_fixture


def make_tests(provider: str):
    fx = load_fixture(provider)

    @pytest.mark.parametrize("case", fx["cases"], ids=[c["name"] for c in fx["cases"]])
    def test_case(case, monkeypatch, frozen_clock):
        monkeypatch.setenv(fx["env"], fx["secret"])
        frozen_clock(fx["generated_at"])
        client = fresh_client(provider)
        res = client.post(f"/webhooks/{provider}", headers=case["headers"], content=case["body"].encode())
        assert res.status_code == case["expect"], f'{case["name"]}: {res.status_code} {res.text}'

    def test_duplicate_acknowledged_not_reprocessed(monkeypatch, frozen_clock):
        monkeypatch.setenv(fx["env"], fx["secret"])
        frozen_clock(fx["generated_at"])
        valid = next(c for c in fx["cases"] if c["name"] == "valid")
        client = fresh_client(provider)
        first = client.post(f"/webhooks/{provider}", headers=valid["headers"], content=valid["body"].encode())
        second = client.post(f"/webhooks/{provider}", headers=valid["headers"], content=valid["body"].encode())
        assert first.status_code == 200 and "duplicate" not in first.json()
        assert second.status_code == 200 and second.json()["duplicate"] is True

    def test_missing_secret_fails_closed(monkeypatch):
        monkeypatch.delenv(fx["env"], raising=False)
        valid = next(c for c in fx["cases"] if c["name"] == "valid")
        res = fresh_client(provider).post(f"/webhooks/{provider}", headers=valid["headers"], content=valid["body"].encode())
        assert res.status_code == 500

    return test_case, test_duplicate_acknowledged_not_reprocessed, test_missing_secret_fails_closed
