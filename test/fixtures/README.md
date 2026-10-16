# Independent QMC test vectors

These fixtures are **synthetic deterministic byte patterns**, not downloaded
recordings or valid playable songs. The first four plaintext bytes are `fLaC`
solely to exercise container format identification. No QQ account, account
database, subscription, or remotely retrieved music key was used.

`reference-vectors/manifest.json` records every vector's SHA-256, size, public
reference origin and synthetic test ekey. The common plaintext is 600123 bytes,
covering the 128-byte, 5120-byte, 32767-byte and 256 KiB stream boundaries.

- QMCv1 was encrypted with the original MIT-licensed C++ `seed::next_mask()`
  downloaded from [presburger/qmc-decoder](https://github.com/presburger/qmc-decoder/blob/master/src/seed.hpp).
  The full keystream was also compared against the separately released Python
  implementation before committing the vectors.
- QMCv2 Map/RC4 and EncV1 ekey wrapping were generated with the original
  [LibTakiyasha 2.1.1.post1 release](https://pypi.org/project/libtakiyasha/2.1.1.post1/),
  not this project's JavaScript decoder. Only the padding random-byte source was
  replaced with a deterministic generator. The reference implementation verified
  its own encryption/decryption round trip before the independent Node tests.
- `reference-src/` retains downloaded algorithm source and the upstream MIT
  licenses; `source-manifest.json` records their original URLs and SHA-256 values.
  `reference-package-manifest.json` records the release package and
  dependency download URLs and SHA-256 values. Those reference dependencies are
  used for reproducing vectors only and are not application dependencies.

To reproduce, first download and verify the exact packages listed in
`reference-package-manifest.json`, install them into a local `reference-python/`
directory, and run from this directory:

```sh
c++ -std=c++17 v1_reference.cpp -o /tmp/qmc-v1-reference
/tmp/qmc-v1-reference > v1-reference-mask.bin
python3 generate_vectors.py
```

The normal Node test suite uses only the committed binary fixtures; it requires
no compiler, Python packages, network access or account credentials.
