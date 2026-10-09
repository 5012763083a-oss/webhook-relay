from provider_suite import make_tests

test_case, test_duplicate_acknowledged_not_reprocessed, test_missing_secret_fails_closed = make_tests("stripe")
