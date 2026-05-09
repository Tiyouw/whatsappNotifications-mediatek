{ pkgs }: {
  deps = [
    pkgs.nodejs_20
    pkgs.ffmpeg
    pkgs.python3
    pkgs.pkg-config
    pkgs.vips
  ];
}
