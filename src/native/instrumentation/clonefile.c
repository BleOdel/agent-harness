#include <sys/clonefile.h>
#include <stdio.h>
int main(int argc, char **argv) {
  if (argc != 3) return 64;
  if (clonefile(argv[1], argv[2], CLONE_NOFOLLOW) != 0) {
    perror("clonefile");
    return 1;
  }
  return 0;
}
