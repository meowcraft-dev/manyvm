const core = require("@actions/core");
const github = require("@actions/github");
const fs = require("fs");
const path = require("path");
const { spawnSync, spawn } = require("child_process");
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
  let filename = `qemu-${triplet}.tar.xz`;
  download_file(
    `https://github.com/cocoa-xu/qemu-build/releases/download/v${version}/${filename}`,
    `/tmp/qemu-${version}-${triplet}.tar.xz`
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
      `mkdir -p /tmp/qemu-${version} && tar -C /tmp/qemu-${version} -xf /tmp/qemu-${version}-${triplet}.tar.xz && touch /tmp/qemu-${version}/.extracted`,
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
  if(!["14.0", "13.2", "12.4"].includes(version)) {
    throw new Error(`Unsupported FreeBSD version: ${version}`);
  }
  let base_url = `https://github.com/uwulab/manyvm-freebsd-builder/releases/download/v${version}`

  let [os_arch, instruction_set] =
    {
      amd64: ["", "amd64"],
      x86_64: ["", "amd64"],
      i386: ["", "i386"],
      aarch64: ["arm64", "aarch64"],
      riscv64: ["riscv", "riscv64"],
    }[arch] ||
    (() => {
      throw new Error(`Unknown architecture: ${arch}`);
    })();

  let filename = `manyvm-FreeBSD-${version}-RELEASE-${
    !os_arch ? "" : `${os_arch}-`
  }${instruction_set}.qcow2.xz`;
  return [
    `${base_url}/${filename}`,
    filename,
  ];
};

function get_filename_from_url(url) {
  const parsed_url = new URL(url);
  const pathname = parsed_url.pathname;
  return path.basename(pathname);
};

function download_file(url, filename) {
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
  const qemu_process = spawn(qemu_cmd, qemu_args);

  let waitForLogin = (() => {
      let concat = ''
      return (data) => {
          concat += data.toString()
          if (concat.includes('login')) {
            ready_callback(qemu_process)
              waitForLogin = () => { }
          }
      }
  })()

  qemu_process.stderr.pipe(process.stderr)

  qemu_process.stdout.on('data', (data) => {
      waitForLogin(data)
  });

  qemu_process.on('close', (code) => {
    show_message("info", `qemu exited with code ${code}`);
  });

  return qemu_process;
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

  qemu_wrapper(qemu_executable, qemu_args, (qemu_process) => {
    setup_sshkey(pubkey, qemu_process, () => {
      let runScript = core.getInput('run');
      fs.writeFileSync('/tmp/run.sh', runScript);
      let ssh = spawn('ssh', ['-o', 'StrictHostKeyChecking=no', '-p', '2222', '-i', pubkey, 'root@localhost']);
      ssh.stdout.pipe(process.stdout);
      ssh.stderr.pipe(process.stderr);
      ssh.stdin.write('chmod +x /tmp/run.sh');
      ssh.stdin.write('bash /tmp/run.sh');
      ssh.on('close', (code) => {
        show_message("info", `ssh exited with code ${code}`);
        qemu_process.kill();
      })
    });
  });
  core.endGroup();
};

function setup_sshkey(pubkey, qemu_process, ready_callback) {
  const pubkeyContent = fs.readFileSync(pubkey, { encoding: "utf-8" });
  show_message("info", "Setting up SSH key for QEMU");
  qemu_process.stdin.write("root\n");
  let waitForKey = (() => {
    let concat = ''
    return (data) => {
      concat += data.toString()
      if (concat.includes("root@freebsd:")) {
        qemu_process.stdin.write("echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config\n");
        qemu_process.stdin.write("/etc/rc.d/sshd restart\n");
        qemu_process.stdin.write(`echo "${pubkeyContent}" > /root/.ssh/authorized_keys\n`);
        qemu_process.stdin.write(`cat /root/.ssh/authorized_keys\n`);
        setTimeout(() => { ready_callback(qemu_process) }, 2000);
        waitForKey = () => { }
      }
    }
  })()
  qemu_process.stdout.on('data', (data) => {
    waitForKey(data)
    process.stdout.write(data.toString())
  });
}

function ensure_install_deps() {
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

  const deps = "libxml2-utils xsltproc libglib2.0-dev gnutls-dev libslirp-dev libyajl-dev meson libosinfo-1.0-dev libcurl4-openssl-dev libreadline-dev libnl-3-dev libudev-dev flex libnfs-dev libssh-dev libssh2-1-dev libpng-dev libusb-dev libsnappy-dev libsdl2-dev libpam0g-dev libbz2-dev liblzma-dev libzstd-dev libcap-ng-dev libjpeg-dev libvde-dev libvdeplug-dev liblzo2-dev ovmf"
  
  result = spawnSync("sudo", ["apt-get", "-y", "install", ...deps.split(' ')], {
    stdio: "inherit",
    env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
  });
  if (result.status === 0) {
    show_message("info", "OVMF installed successfully.");
  } else {
    show_message("fatal", `Error installing OVMF. Exit code: ${result.status}`);
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
  const qemu_version = "8.2.2";
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

  filename = path.resolve(`${process.cwd()}/${filename}`);

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
  ensure_install_deps();
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
        bios = "/usr/share/qemu/OVMF.fd";
        break;
      case "aarch64":
        bios = "edk2-aarch64-code.fd";
        break;
      case "riscv64":
        bios = "fw_payload.elf";
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
        machine = "virt,gic-version=3";
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
