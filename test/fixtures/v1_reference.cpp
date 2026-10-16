#include <cstdint>
#include <cstdio>
#include "reference-src/presburger/seed.hpp"
int main() {
    qmc_decoder::seed reference;
    for (std::size_t i = 0; i < 600123; ++i) {
        std::putchar(reference.next_mask());
    }
}
