// Tart's file-handle network device terminates here. No socket is opened and
// no Ethernet frame is forwarded. The guest has no path to host/LAN/internet.
#include <unistd.h>
#include <errno.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc != 5 || strcmp(argv[1], "--vm-fd") || strcmp(argv[2], "0") ||
      strcmp(argv[3], "--vm-mac-address")) return 64;
  char frame[65536];
  for (;;) {
    ssize_t size = read(STDIN_FILENO, frame, sizeof frame);
    if (size > 0) continue;
    if (size < 0 && errno == EINTR) continue;
    return size == 0 ? 0 : 1;
  }
}
