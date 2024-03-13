const core = require("@actions/core");
const github = require("@actions/github");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const expandHomeDir = require("expand-home-dir");

function show_message(type, message) {
  if (type == "error") {
    core.setFailed(message);
  } else if (type == "fatal") {
    core.setFailed(message);
    process.exit(1);
  } else {
    core.info(message);
  }
};

function setup_precompiled_qemu(version) {
  show_message("info", `Downloading QEMU ${version}`);
  let triplet = "x86_64-linux-gnu";
  let filename = `qemu-${triplet}.tar.gz`;
  download_file(
    `https://github.com/cocoa-xu/qemu-build/releases/download/v${version}/${filename}`,
    `/tmp/qemu-${version}-${triplet}.tar.gz`
  );

  if (fs.existsSync(`/tmp/qemu-${version}/.extracted`)) {
    show_message("info", `QEMU ${version} already extracted, skipping.`);
    return;
  }

  show_message("info", `Extracting QEMU ${version}`);
  const result = spawnSync(
    "bash",
    [
      "-c",
      `mkdir -p /tmp/qemu-${version} && tar -C /tmp/qemu-${version} -xzf /tmp/qemu-${version}-${triplet}.tar.gz && touch /tmp/qemu-${version}/.extracted`,
    ],
    {
      stdio: "inherit",
    }
  );
  if (result.status === 0) {
    show_message("info", `QEMU ${version} extracted successfully.`);
  } else {
    show_message(
      "fatal",
      `Error extracting QEMU ${version}. Exit code: ${result.status}`
    );
  }
};

function get_freebsd_image_url_template(version, arch) {
  version == "latest" && (version = "14.0");
  let [base_url, subdir] = ["14.0", "13.2", "12.4"].includes(version)
    ? [
        `https://download.freebsd.org/releases/VM-IMAGES/${version}-RELEASE`,
        "Latest",
      ]
    : [
        `http://ftp-archive.freebsd.org/pub/FreeBSD-Archive/old-releases/VM-IMAGES/${version}-RELEASE`,
        "",
      ];

  let [url_arch, os_arch, instruction_set] =
    {
      amd64: ["amd64", "", "amd64"],
      x86_64: ["amd64", "", "amd64"],
      i386: ["i386", "", "i386"],
      aarch64: ["aarch64", "arm64", "aarch64"],
      riscv64: ["riscv64", "riscv", "riscv64"],
    }[arch] ||
    (() => {
      throw new Error(`Unknown architecture: ${arch}`);
    })();

  let filename = `FreeBSD-${version}-RELEASE-${
    !os_arch ? "" : `${os_arch}-`
  }${instruction_set}.qcow2.xz`;
  return [
    `${base_url}/${url_arch}/${!subdir ? "" : `${subdir}/`}${filename}`,
    filename,
  ];
};

function get_filename_from_url(url) {
  const parsed_url = new URL(url);
  const pathname = parsed_url.pathname;
  return path.basename(pathname);
};

download_file = (url, filename) => {
  if (fs.existsSync(filename)) {
    show_message("info", `File ${filename} already exists, skipping.`);
    return;
  }

  const result = spawnSync("curl", ["-fSL", url, "-o", filename], {
    stdio: "inherit",
  });
  if (result.status === 0) {
    show_message("info", "File downloaded successfully.");
  } else {
    show_message(
      "fatal",
      `Error downloading the file. Exit code: ${result.status}`
    );
  }
};

function ensure_host_ssh_key() {
  const pubkey = expandHomeDir("~/.ssh/id_rsa.pub");
  const privkey = expandHomeDir("~/.ssh/id_rsa");
  if (fs.existsSync(pubkey)) {
    show_message("info", "SSH key already exists, skipping.");
  } else {
    const result = spawnSync(
      "ssh-keygen",
      ["-t", "rsa", "-N", "", "-f", privkey],
      {
        stdio: "inherit",
      }
    );
    if (result.status === 0) {
      show_message("info", "SSH key generated successfully.");
    } else {
      show_message(
        "fatal",
        `Error generating SSH key. Exit code: ${result.status}`
      );
    }
  }
  return pubkey;
};

function qemu_wrapper(qemu_cmd, qemu_args, ready_callback) {
  show_message("info", 'starting qemu process with command: ' + qemu_cmd + ' ' + qemu_args.join(' '));
  const qemuProcess = spawn(qemu_cmd, qemu_args);

  let waitForLogin = (() => {
      let concat = ''
      return (data) => {
          concat += data.toString()
          if (concat.includes('login')) {
              ready_callback(qemuProcess)
              waitForLogin = () => { }
          }
      }
  })()

  qemuProcess.stdout.on('data', (data) => {
      waitForLogin(data)
  });

  qemuProcess.on('close', (code) => {
    show_message("info", `qemu exited with code ${code}`);
  });

  return qemuProcess;
}

function start_vm(qemu_version, os, cpu, arch, bios, machine, filename, pubkey) {
  core.startGroup("Start VM");
  show_message("info", "Starting VM");

  const qemu_executable = `/tmp/qemu-${qemu_version}/usr/local/bin/qemu-system-${arch}`;
  let qemu_args = [];
  switch (arch) {
    case "amd64":
    case "x86_64":
    case "i386":
      qemu_args = [
        "-machine", machine,
        "-cpu", cpu,
        "-smp", "4",
        "-bios", bios,
        "-m", "2048",
        "-nographic",
        "-drive", `file=${filename},format=qcow2`,
        "-netdev", `user,id=net0,hostfwd=tcp::2222-:22`,
        "-device", "virtio-net-pci,netdev=net0"
      ];
      break;
    case "aarch64":
      qemu_args = [
        "-machine", machine,
        "-cpu", cpu,
        "-smp", "4",
        "-bios", bios,
        "-m", "2048",
        "-nographic",
        "-drive", `file=${filename},format=qcow2`,
        "-netdev", `user,id=net0,hostfwd=tcp::2222-:22`,
        "-device", "virtio-net-pci,netdev=net0"
      ];
      break;
    case "riscv64":
      qemu_args = [
        "-machine", machine,
        "-cpu", cpu,
        "-bios", bios,
        "-m", "2048",
        "-nographic",
        "-drive", `file=${filename},format=qcow2`,
        "-netdev", `user,id=net0,hostfwd=tcp::2222-:22`,
        "-device", "virtio-net-pci,netdev=net0"
      ];
      break;
  }

  show_message("info", qemu_executable + ' ' + qemu_args.join(' '));

  // qemu_wrapper(qemu_executable, qemu_args, (qemu_process) => {
  //   let ssh_ready = false;
  //   let do_ssh_callback = () => {
  //     qemu_executable.stdin.write("mkdir -p ~/.ssh && cat > ~/.ssh/authorized_keys <<EOF && chmod 600 ~/.ssh/authorized_keys && echo 'sshd_enable=\"YES\"' >> /etc/rc.conf && echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config && /etc/rc.d/sshd start && /etc/rc.d/sshd restart\n");
  //     qemu_executable.stdin.write(pubkey + "\nEOF\n");
  //   };

  //   let waitForPrompt = (() => {
  //     let concat = ''
  //     return (data) => {
  //       concat += data.toString()
  //       if (concat.includes('root@freebsd:~ #')) {
  //         if (!ssh_ready) {
  //           ssh_ready = true;
  //           do_ssh_callback();
  //         } else {
  //           show_message("info", "SSH okay. VM is ready to use.");
  //           waitForLogin = () => { }
  //         }
  //       }
  //     }
  //   })()

  //   qemu_process.stdout.on('data', (data) => {
  //     waitForPrompt(data)
  //   });
  //   qemu_process.stdin.write('root\n')
  // });
  core.endGroup();
};

function ensure_install_ovmf() {
  if (fs.existsSync("/usr/share/qemu/OVMF.fd")) {
    show_message("info", "OVMF already installed, skipping.");
  } else {
    show_message("info", "Installing OVMF");
    let result = spawnSync("sudo", ["apt-get", "update"], {
      stdio: "inherit",
      env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
    });
    if (result.status === 0) {
      show_message("info", "OVMF installed successfully.");
    } else {
      show_message("fatal", `Error installing OVMF. Exit code: ${result.status}`);
    }
    
    result = spawnSync("sudo", ["apt-get", "-y", "install", "ovmf"], {
      stdio: "inherit",
      env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
    });
    if (result.status === 0) {
      show_message("info", "OVMF installed successfully.");
    } else {
      show_message("fatal", `Error installing OVMF. Exit code: ${result.status}`);
    }
  }
};

try {
  let os = core.getInput('os');
  let version = core.getInput('version');
  let arch = core.getInput('arch');
  let cpu = core.getInput('cpu');
  let bios = core.getInput('bios');
  let machine = core.getInput('machine');
  let os_image_url = core.getInput('os_image_url');

  // await shell("bash run.sh onStarted" );
  //   core.endGroup();

  core.startGroup("Set up QEMU");
  const qemu_version = "8.2.0";
  setup_precompiled_qemu(qemu_version);
  core.endGroup();

  core.startGroup("Download system image");
  let filename = "";

  // let [os, version, arch, cpu, bios, machine] = [
  //   "freebsd",
  //   "latest",
  //   "amd64",
  //   "auto",
  //   "auto",
  //   "auto",
  // ];

  if (os_image_url) {
    filename = get_filename_from_url(os_image_url);
    show_message("info", `Using custom image URL: ${os_image_url}`);
  } else {
    switch (os) {
      case "freebsd":
        [os_image_url, filename] = get_freebsd_image_url_template(
          version,
          arch
        );
        break;
      default:
        show_message("fatal", `Unknown OS: ${os}`);
    }
    show_message("info", `Using image URL: ${os_image_url}`);
  }

  filename = path.resolve(process.cwd(), filename);

  let uncompressed_filename = filename;
  if (filename.endsWith(".xz")) {
    uncompressed_filename = filename.replace(".xz", "");
  }

  if (fs.existsSync(uncompressed_filename)) {
    show_message(
      "info",
      `Uncompressed image ${uncompressed_filename} already exists, skipping.`
    );
  } else {
    if (fs.existsSync(filename)) {
      show_message("info", `Image ${filename} already exists, skipping.`);
    } else {
      show_message("info", `Downloading ${os} image from ${os_image_url}`);
      download_file(os_image_url, filename);
    }

    show_message("info", `Decompressing image`);
    const result = spawnSync("bash", ["-c", `xz -d -k -T0 ${filename}`], {
      stdio: "inherit",
    });
    if (result.status === 0) {
      show_message("info", "Image decompressed successfully.");
    } else {
      show_message(
        "fatal",
        `Error decompressing image. Exit code: ${result.status}`
      );
    }
  }
  core.endGroup();

  core.startGroup("Prepare VM");
  let pubkey = ensure_host_ssh_key();
  if (cpu == "auto") {
    switch (arch) {
      case "amd64":
      case "x86_64":
      case "i386":
        cpu = "qemu64";
        break;
      case "aarch64":
        cpu = "cortex-a72";
        break;
      case "riscv64":
        cpu = "rv64";
        break;
      default:
        show_message("fatal", `Unknown architecture: ${arch}`);
    }
  }

  if (bios == "auto") {
    switch (arch) {
      case "amd64":
      case "x86_64":
      case "i386":
        ensure_install_ovmf();
        bios = "/usr/share/qemu/OVMF.fd";
        break;
      case "aarch64":
        bios = "edk2-aarch64-code.fd";
        break;
      case "riscv64":
        bios = "opensbi-riscv64-generic-fw_dynamic.bin";
        break;
      default:
        show_message("fatal", `Unknown architecture: ${arch}`);
    }
  }

  if (machine == "auto") {
    switch (arch) {
      case "amd64":
      case "x86_64":
      case "i386":
        machine = "pc";
        break;
      case "aarch64":
        machine = "virt,gic-version=2";
        break;
      case "riscv64":
        machine = "virt";
        break;
      default:
        show_message("fatal", `Unknown architecture: ${arch}`);
    }
  }
  core.endGroup();

  start_vm(
    qemu_version,
    os,
    cpu,
    arch,
    bios,
    machine,
    uncompressed_filename,
    pubkey
  );
  
} catch (error) {
  show_message("fatal", error.message);
}
