Mix.install([
  {:expty, "~> 0.1", github: "cocoa-xu/ExPTY"}
])

defmodule QemuVm do
  use GenServer

  @impl true
  def init(opts) do
    {:ok, %{status: :start_vm, opts: opts}}
  end

  def start_vm(pid) do
    GenServer.call(pid, :start_vm, :infinity)
  end

  def write(pid, data) do
    GenServer.call(pid, {:write, data}, :infinity)
  end

  def on_exit(ExPTY, _erl_pid, exit_code, signal_code) do
    IO.puts("exit_code=#{exit_code}, signal_code=#{signal_code}")
  end

  @impl true
  def handle_call({:write, data}, _from, state = %{pty: pty}) do
    ExPTY.write(pty, data)
    {:reply, :ok, state}
  end

  def handle_call(:start_vm, _from, %{status: :start_vm, opts: opts}) do
    os = opts[:os] || "freebsd"

    if os != "freebsd" do
      raise "Only FreeBSD is tested and support at the moment"
    end

    arch = opts[:arch] || "aarch64"
    image = opts[:image] || raise "no image specified"
    pubkey = opts[:pubkey] || Path.expand("~/.ssh/id_rsa.pub")
    cpu = opts[:cpu] || "cortex-a57"
    smp = opts[:smp] || 4
    bios = opts[:bios] || "edk2-aarch64-code.fd"
    format = opts[:image_format] || List.last(String.split(image, "."))
    memory = opts[:m] || opts[:memory] || "2G"
    machine = opts[:M] || opts[:machine] || "virt,gic-version=2"
    qemu = System.find_executable("qemu-system-#{arch}")

    if qemu == nil do
      raise "Cannot find `qemu-system-#{arch}` on the system"
    else
      IO.puts("Using qemu: #{qemu}")
    end

    qemu_argv =
      if arch == "x86_64" do
        ~w(-M #{machine} -m #{memory} -cpu #{cpu} -smp #{smp} -bios #{bios}
        -drive if=virtio,file=#{image},id=drv,format=#{format}
        -device virtio-rng-pci
        -net nic,model=virtio,macaddr=52:54:00:00:00:01
        -net user,hostfwd=tcp::22222-:22
        -nographic
        -display none
        -nodefaults
        -serial mon:stdio)
      else
        ~w(-M #{machine} -m #{memory} -cpu #{cpu} -smp #{smp} -bios #{bios}
        -drive if=none,file=#{image},id=drv,format=#{format}
        -device virtio-blk-pci,drive=drv
        -device virtio-rng-pci
        -net nic,model=virtio,macaddr=52:54:00:00:00:01
        -net user,hostfwd=tcp::22222-:22
        -nographic
        -display none)
      end

    {:ok, pty} =
      ExPTY.spawn(
        qemu,
        qemu_argv,
        on_data: fn _, _, data ->
          IO.binwrite(data)
          GenServer.cast(__MODULE__, {:message, data})
        end,
        on_exit: __MODULE__
      )

    {:reply, :ok, %{pty: pty, lastline: "", pubkey: pubkey}}
  end

  @impl true
  def handle_cast({:message, chunk}, state = %{lastline: lastline}) do
    lastline = "#{lastline}#{chunk}"

    lastline =
      if String.contains?(lastline, "\n") do
        List.last(String.split(lastline, "\n"))
      else
        lastline
      end

    handle_lastline(lastline, state)
  end

  @impl true
  def terminate(_reason, %{pty: pty}) do
    ExPTY.kill(pty, 9)
  end

  defp handle_login(state = %{pty: pty}) do
    ExPTY.write(pty, "root\n")
    {:noreply, state}
  end

  defp setup_ssh(%{pty: pty, pubkey: pubkey}) do
    ssh_key = File.read!(pubkey)

    :timer.sleep(1500)

    ExPTY.write(
      pty,
      "mkdir -p ~/.ssh && cat > ~/.ssh/authorized_keys <<EOF && chmod 600 ~/.ssh/authorized_keys && echo 'sshd_enable=\"YES\"' >> /etc/rc.conf && echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config && /etc/rc.d/sshd restart\n"
    )

    :timer.sleep(100)

    chunk_size = 32 * 8

    chunks(ssh_key, chunk_size)
    |> Enum.each(fn chunk ->
      ExPTY.write(pty, chunk)
      :timer.sleep(10)
    end)

    ExPTY.write(pty, "\nEOF\n")
    {:noreply, %{pty: pty, lastline: "root@freebsd:~ # ", vm_ready: true}}
  end

  defp handle_lastline(nil, state) do
    {:noreply, %{state | lastline: ""}}
  end

  defp handle_lastline("login: ", state) do
    handle_login(state)
    {:noreply, %{state | lastline: "login: "}}
  end

  defp handle_lastline("root@freebsd:~ # ", state) do
    if Map.get(state, :vm_ready) == nil do
      setup_ssh(state)
    else
      {:noreply, %{state | lastline: "root@freebsd:~ # "}}
    end
  end

  defp handle_lastline(lastline, state) do
    {:noreply, %{state | lastline: lastline}}
  end

  def chunks(binary, n) do
    do_chunks(binary, n, [])
  end

  defp do_chunks(binary, n, acc) when bit_size(binary) <= n do
    Enum.reverse([binary | acc])
  end

  defp do_chunks(binary, n, acc) do
    <<chunk::size(n), rest::bitstring>> = binary
    do_chunks(rest, n, [<<chunk::size(n)>> | acc])
  end
end

[os, cpu, arch, bios, machine, image_file, pubkey] = System.argv()

arch =
  case arch do
    "amd64" ->
      "x86_64"

    "arm64" ->
      "aarch64"

    _ ->
      arch
  end

{:ok, freebsd} =
  GenServer.start_link(
    QemuVm,
    [
      os: os,
      cpu: cpu,
      arch: arch,
      bios: bios,
      machine: machine,
      image: image_file,
      pubkey: pubkey,
      ibaudrate: 115200,
      obaudrate: 115200
    ],
    name: QemuVm
  )

QemuVm.start_vm(freebsd)
