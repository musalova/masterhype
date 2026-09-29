// MasterHype BurnHelper — masterizzazione CD via Windows IMAPI2.
// Compilare con csc.exe (Framework 4.0, già presente in Windows):
//   csc /target:exe /platform:anycpu /out:BurnHelper.exe BurnHelper.cs
//
// Comandi (output = righe JSON su stdout):
//   list-drives                                  -> rileva masterizzatori + stato disco
//   burn-data  --drive <id> --files <list.txt> --label <nome>  -> MP3/data CD (ISO via MsftFileSystemImage)
//   burn-audio --drive <id> --files <list.txt>                 -> Audio CD CDA (WAV 44.1/16/stereo)
//   erase      --drive <id> [--full]             -> cancella CD-RW
//   eject      --drive <id>
//
// Nota: sintassi C# 5 (il csc.exe di sistema non supporta C# 6+).
// Oggetti IMAPI2 via ProgID + dynamic (IDispatch); interfacce tipizzate solo
// dove servono parametri IStream (IID dall'SDK Windows documentato).

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

[ComImport, Guid("27354153-9F64-5B0F-8F00-5D77AFBE261E"),
 InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
interface IDiscFormat2Data
{
    void Write([MarshalAs(UnmanagedType.Interface)] IStream data);
    void CancelWrite();
}

[ComImport, Guid("27354129-7F64-5B0F-8F00-5D77AFBE261E"),
 InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
interface IDiscFormat2TrackAtOnce
{
    void AddAudioTrack([MarshalAs(UnmanagedType.Interface)] IStream data);
    void CancelAddTrack();
}

// IStream che legge un file e conta i byte -> progress reale durante la scrittura.
class CountingStream : IStream
{
    private readonly FileStream inner;
    private readonly long total;
    private long read;
    private int lastPct = -1;
    private readonly string label;
    private readonly long offsetBase;
    private readonly long grandTotal;

    public CountingStream(string path, string label) : this(path, label, 0, 0) { }

    public CountingStream(string path, string label, long offsetBase, long grandTotal)
    {
        inner = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        total = inner.Length;
        this.label = label;
        this.offsetBase = offsetBase;
        this.grandTotal = grandTotal > 0 ? grandTotal : total;
    }

    public void Read(byte[] pv, int cb, IntPtr pcbRead)
    {
        int n = inner.Read(pv, 0, cb);
        read += n;
        if (pcbRead != IntPtr.Zero) Marshal.WriteInt32(pcbRead, n);
        int pct = (int)((offsetBase + read) * 100 / grandTotal);
        if (pct != lastPct)
        {
            lastPct = pct;
            Json.Line("{\"phase\":\"write\",\"percent\":" + pct + ",\"current\":\"" + Json.Esc(label) + "\"}");
        }
    }

    public void Seek(long dlibMove, int dwOrigin, IntPtr plibNewPosition)
    {
        long pos = inner.Seek(dlibMove, (SeekOrigin)dwOrigin);
        if (plibNewPosition != IntPtr.Zero) Marshal.WriteInt64(plibNewPosition, pos);
    }

    public void Stat(out System.Runtime.InteropServices.ComTypes.STATSTG pstatstg, int grfStatFlag)
    {
        pstatstg = new System.Runtime.InteropServices.ComTypes.STATSTG();
        pstatstg.cbSize = total;
    }

    public void SetSize(long libNewSize) { inner.SetLength(libNewSize); }
    public void Write(byte[] pv, int cb, IntPtr pcbWritten) { throw new NotSupportedException(); }
    public void CopyTo(IStream pstm, long cb, IntPtr pcbRead, IntPtr pcbWritten) { throw new NotSupportedException(); }
    public void Commit(int grfCommitFlags) { }
    public void Revert() { }
    public void LockRegion(long libOffset, long cb, int dwLockType) { throw new NotSupportedException(); }
    public void UnlockRegion(long libOffset, long cb, int dwLockType) { throw new NotSupportedException(); }
    public void Clone(out IStream ppstm) { ppstm = null; throw new NotSupportedException(); }
}

// WAV canonico per IMAPI2: AddAudioTrack rifiuta sia chunk extra (LIST/INFO/
// bext -> "flusso audio non valido") sia IStream managed custom. Soluzione:
// riscrittura del file con solo RIFF+fmt+data + stream nativo SHCreateStreamOnFileEx.
static class Wav
{
    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    static extern int SHCreateStreamOnFileEx(string pszFile, uint grfMode, uint dwAttrs,
        bool fCreate, IStream pstmTemplate, out IStream ppstm);

    public static IStream OpenStream(string path)
    {
        IStream s;
        int hr = SHCreateStreamOnFileEx(path, 0x00000020, 0, false, null, out s); // STGM_SHARE_DENY_WRITE (read)
        if (hr != 0 || s == null) throw new COMException("SHCreateStreamOnFileEx", hr);
        return s;
    }

    // Se il WAV ha chunk extra scrive una copia canonica in temp e ne torna il path.
    public static string EnsureClean(string src, List<string> temps)
    {
        using (var fs = new FileStream(src, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            byte[] head12 = new byte[12];
            if (fs.Read(head12, 0, 12) != 12 || Encoding.ASCII.GetString(head12, 0, 4) != "RIFF" ||
                Encoding.ASCII.GetString(head12, 8, 4) != "WAVE")
                throw new Exception("non è un WAV: " + src);
            byte[] fmt = null;
            long dOff = 0, dLen = 0;
            bool dirty = false;
            byte[] chdr = new byte[8];
            while (fs.Read(chdr, 0, 8) == 8)
            {
                string cid = Encoding.ASCII.GetString(chdr, 0, 4);
                uint csz = BitConverter.ToUInt32(chdr, 4);
                if (cid == "fmt ")
                {
                    fmt = new byte[csz];
                    if (fs.Read(fmt, 0, (int)csz) != (int)csz) throw new Exception("WAV troncato: " + src);
                    if (fmt.Length != 16 || BitConverter.ToUInt16(fmt, 0) != 1) dirty = true;
                    if ((csz & 1) != 0) fs.Seek(1, SeekOrigin.Current);
                }
                else if (cid == "data")
                {
                    if (dOff != 0) dirty = true;
                    dOff = fs.Position; dLen = Math.Min(csz, fs.Length - fs.Position);
                    fs.Seek(dLen + (dLen & 1), SeekOrigin.Current);
                }
                else { dirty = true; fs.Seek(csz + (csz & 1), SeekOrigin.Current); }
            }
            if (fmt == null || dOff == 0) throw new Exception("WAV senza fmt/data: " + src);
            if (!dirty) return src; // già canonico
            string dst = Path.Combine(Path.GetTempPath(), "mh-wav-" + Guid.NewGuid().ToString("N") + ".wav");
            temps.Add(dst);
            using (var outp = new FileStream(dst, FileMode.Create, FileAccess.Write))
            {
                var bw = new BinaryWriter(outp);
                bw.Write(Encoding.ASCII.GetBytes("RIFF"));
                bw.Write((uint)(4 + 8 + 16 + 8 + dLen));
                bw.Write(Encoding.ASCII.GetBytes("WAVE"));
                bw.Write(Encoding.ASCII.GetBytes("fmt "));
                bw.Write((uint)16);
                byte[] f16 = new byte[16];
                Array.Copy(fmt, f16, Math.Min(16, fmt.Length));
                bw.Write(f16);
                bw.Write(Encoding.ASCII.GetBytes("data"));
                bw.Write((uint)dLen);
                fs.Position = dOff;
                byte[] buf = new byte[1 << 20];
                long left = dLen;
                while (left > 0)
                {
                    int r = fs.Read(buf, 0, (int)Math.Min(buf.Length, left));
                    if (r <= 0) break;
                    outp.Write(buf, 0, r); left -= r;
                }
            }
            return dst;
        }
    }
}

// IStream contatore che wrappa un IStream esistente (immagine ISO di FileSystemImage)
class PassthroughStream : IStream
{
    private readonly IStream inner;
    private readonly long total;
    private long read;
    private int lastPct = -1;
    private readonly string label;
    private readonly long offsetBase;
    private readonly long grandTotal;

    public PassthroughStream(IStream inner, long total) : this(inner, total, null, 0, 0) { }

    public PassthroughStream(IStream inner, long total, string label, long offsetBase, long grandTotal)
    {
        this.inner = inner; this.total = total; this.label = label;
        this.offsetBase = offsetBase; this.grandTotal = grandTotal;
    }

    public void Read(byte[] pv, int cb, IntPtr pcbRead)
    {
        inner.Read(pv, cb, pcbRead);
        int n = pcbRead != IntPtr.Zero ? Marshal.ReadInt32(pcbRead) : cb;
        read += n;
        int pct = label != null
            ? (int)((offsetBase + read) * 100 / (grandTotal > 0 ? grandTotal : total))
            : 10 + (int)(read * 88 / total); // fascia 10-98%
        if (pct != lastPct)
        {
            lastPct = pct;
            Json.Line("{\"phase\":\"write\",\"percent\":" + pct + (label != null ? ",\"current\":\"" + Json.Esc(label) + "\"}" : "}"));
        }
    }

    public void Seek(long dlibMove, int dwOrigin, IntPtr plibNewPosition) { inner.Seek(dlibMove, dwOrigin, plibNewPosition); }
    public void Stat(out System.Runtime.InteropServices.ComTypes.STATSTG pstatstg, int grfStatFlag) { inner.Stat(out pstatstg, grfStatFlag); }
    public void SetSize(long libNewSize) { throw new NotSupportedException(); }
    public void Write(byte[] pv, int cb, IntPtr pcbWritten) { throw new NotSupportedException(); }
    public void CopyTo(IStream pstm, long cb, IntPtr pcbRead, IntPtr pcbWritten) { throw new NotSupportedException(); }
    public void Commit(int grfCommitFlags) { inner.Commit(grfCommitFlags); }
    public void Revert() { inner.Revert(); }
    public void LockRegion(long libOffset, long cb, int dwLockType) { throw new NotSupportedException(); }
    public void UnlockRegion(long libOffset, long cb, int dwLockType) { throw new NotSupportedException(); }
    public void Clone(out IStream ppstm) { ppstm = null; throw new NotSupportedException(); }
}

static class Json
{
    public static void Line(string s) { Console.Out.WriteLine(s); Console.Out.Flush(); }
    public static string Esc(string s) { return s.Replace("\\", "\\\\").Replace("\"", "\\\""); }
    public static string Err(string msg) { Line("{\"phase\":\"error\",\"message\":\"" + Esc(msg) + "\"}"); return msg; }
}

// Cache capacità per-drive: se un drive rifiuta il CD-Text (o il DAO) una volta,
// non si riprova mai più — salta diretto alla strategia successiva.
// Formato line-based robusto (niente JSON fatto a mano): "driveid|cap=0|1" a riga.
static class DriveCaps
{
    static string CapsPath() { return Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "MasterHype", "burn-caps.txt"); }

    public static bool? Get(string driveName, string cap)
    {
        try
        {
            var needle = cap + "=";
            foreach (var line in File.ReadAllLines(CapsPath()))
            {
                int p = line.IndexOf('|');
                if (p < 0 || line.Substring(0, p) != driveName) continue;
                int q = line.IndexOf(needle, p + 1);
                if (q < 0) continue;
                return line[q + needle.Length] == '0' ? (bool?)false : true;
            }
            return null;
        }
        catch { return null; }
    }

    public static void Set(string driveName, string cap, bool val)
    {
        try
        {
            var lines = File.Exists(CapsPath())
                ? new List<string>(File.ReadAllLines(CapsPath())) : new List<string>();
            var needle = cap + "=";
            for (int i = 0; i < lines.Count; i++)
            {
                int p = lines[i].IndexOf('|');
                if (p < 0 || lines[i].Substring(0, p) != driveName) continue;
                int q = lines[i].IndexOf(needle, p + 1);
                if (q >= 0)
                    lines[i] = lines[i].Substring(0, q) + needle + (val ? "1" : "0");
                else
                    lines[i] = lines[i] + "|" + needle + (val ? "1" : "0");
                WriteCaps(lines); return;
            }
            lines.Add(driveName + "|" + needle + (val ? "1" : "0"));
            WriteCaps(lines);
        }
        catch { }
    }

    static void WriteCaps(List<string> lines)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(CapsPath()));
        File.WriteAllLines(CapsPath(), lines.ToArray());
    }
}

// ==================== SCSI pass-through (DAO + CD-Text) ====================
// IMAPI2 non supporta CD-Text: per scrivere titoli/autori leggibili dall'
// autoradio usiamo Session-At-Once diretto via SPTI, come cdrdao:
//   MODE SELECT p.05 (SAO) -> SEND CUE SHEET (lead-in dataform 0x41) ->
//   WRITE(10) subcanali R-W nel lead-in -> gap 150 settori -> audio -> sync.
// Riferimenti: MMC-3 §5.29, sorgente cdrdao GenericMMC.cc / CdTextEncoder.cc.

[StructLayout(LayoutKind.Sequential)]
struct ScsiPassThroughDirect
{
    public ushort Length;
    public byte ScsiStatus;
    public byte PathId;
    public byte TargetId;
    public byte Lun;
    public byte CdbLength;
    public byte SenseInfoLength;
    public byte DataIn;            // 0=out 1=in 2=none
    public uint DataTransferLength;
    public uint TimeOutValue;      // secondi
    public IntPtr DataBuffer;
    public uint SenseInfoOffset;   // offset dal ponte alla struct
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
    public byte[] Cdb;
}

class ScsiDevice : IDisposable
{
    const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;
    const uint FILE_SHARE_RW = 0x00000003;
    const uint OPEN_EXISTING = 3;
    const uint IOCTL_SCSI_PASS_THROUGH_DIRECT = 0x0004D014;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share,
        IntPtr sec, uint mode, uint flags, IntPtr tmpl);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(SafeFileHandle h, uint code,
        IntPtr inBuf, uint inSize, IntPtr outBuf, uint outSize,
        out uint bytesRet, IntPtr overlapped);

    readonly SafeFileHandle handle;
    public byte[] Sense = new byte[0];
    public int LastError;

    ScsiDevice(SafeFileHandle h) { handle = h; }

    public static ScsiDevice Open(string driveLetter)
    {
        // driveLetter tipo "D:\\" -> "\\\\.\\D:"
        string path = "\\\\.\\" + driveLetter.TrimEnd('\\');
        var h = CreateFile(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_RW,
            IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (h.IsInvalid) return null;
        return new ScsiDevice(h);
    }

    public void Dispose() { if (handle != null) handle.Dispose(); }

    // 0 = ok, 1 = errore trasporto, 2 = check condition (Sense valorizzato)
    public int Send(byte[] cdb, byte[] outData, byte[] inData, int timeoutSec)
    {
        int sptdLen = Marshal.SizeOf(typeof(ScsiPassThroughDirect));
        int senseLen = 32;
        int dataLen = outData != null ? outData.Length : (inData != null ? inData.Length : 0);
        IntPtr req = Marshal.AllocHGlobal(sptdLen + senseLen);
        // buffer allineato a 512 byte (richiesto da molti bridge USB/SATA)
        IntPtr raw = Marshal.AllocHGlobal(dataLen + 512);
        IntPtr data = new IntPtr((raw.ToInt64() + 511) & ~511L);
        try
        {
            // azzera l'area sense
            for (int i = 0; i < senseLen; i++) Marshal.WriteByte(req, sptdLen + i, 0);
            if (outData != null) Marshal.Copy(outData, 0, data, outData.Length);
            else if (dataLen > 0) for (int i = 0; i < dataLen; i++) Marshal.WriteByte(data, i, 0);

            var sptd = new ScsiPassThroughDirect();
            sptd.Length = (ushort)sptdLen;
            sptd.CdbLength = (byte)cdb.Length;
            sptd.SenseInfoLength = (byte)senseLen;
            sptd.DataIn = (byte)(inData != null ? 1 : (outData != null ? 0 : 2));
            sptd.DataTransferLength = (uint)dataLen;
            sptd.TimeOutValue = (uint)timeoutSec;
            sptd.DataBuffer = data;
            sptd.SenseInfoOffset = (uint)sptdLen;
            sptd.Cdb = new byte[16];
            Array.Copy(cdb, sptd.Cdb, Math.Min(16, cdb.Length));
            Marshal.StructureToPtr(sptd, req, false);

            uint ret;
            bool ok = DeviceIoControl(handle, IOCTL_SCSI_PASS_THROUGH_DIRECT,
                req, (uint)(sptdLen + senseLen), req, (uint)(sptdLen + senseLen),
                out ret, IntPtr.Zero);
            if (!ok) { LastError = Marshal.GetLastWin32Error(); return 1; }

            int senseUsed = Marshal.ReadByte(req, 7); // SenseInfoLength riscritta dal driver (offset 7 nella struct)
            senseUsed = Math.Min(senseUsed, senseLen);
            Sense = new byte[senseUsed];
            if (senseUsed > 0)
            {
                byte[] tmp = new byte[senseLen];
                Marshal.Copy(new IntPtr(req.ToInt64() + sptdLen), tmp, 0, senseLen);
                Array.Copy(tmp, Sense, senseUsed);
            }
            byte scsiStatus = Marshal.ReadByte(req, 2);
            if (scsiStatus != 0) return 2;
            if (inData != null) Marshal.Copy(data, inData, 0, inData.Length);
            return 0;
        }
        finally
        {
            Marshal.FreeHGlobal(req);
            Marshal.FreeHGlobal(raw);
        }
    }

    public bool TestUnitReady()
    {
        int r = Send(new byte[6], null, null, 20);
        if (r == 0) return true;
        // unit attention (senso 6) va ignorata: riprova una volta
        if (r == 2 && Sense.Length >= 3 && (Sense[2] & 0x0f) == 0x06)
            return Send(new byte[6], null, null, 20) == 0;
        return false;
    }

    // true se il senso indica "long write in progress" (riprovare).
    // Attenzione al formato: 0x70-0x71 = fixed (ASC a byte 12, ASCQ a 13),
    // 0x72-0x73 = descriptor (key a byte 1, ASC a 2, ASCQ a 3).
    public bool SenseIsLongWrite()
    {
        if (Sense.Length < 4) return false;
        int f = Sense[0] & 0x7f;
        if (f == 0x70 || f == 0x71)
            return Sense.Length >= 14 && (Sense[2] & 0x0f) == 0x2 && Sense[7] >= 6 &&
                Sense[12] == 0x4 && (Sense[13] == 0x8 || Sense[13] == 0x7);
        if (f == 0x72 || f == 0x73)
            return (Sense[1] & 0x0f) == 0x2 && Sense[2] == 0x4 &&
                (Sense[3] == 0x8 || Sense[3] == 0x7);
        return false;
    }

    // Send con retry su "long write in progress": un cue sheet abortito lascia
    // il drive occupato a lungo (02/04/08) mentre svuota il buffer.
    public int SendWait(byte[] cdb, byte[] outData, byte[] inData, int timeoutSec, int waitSec)
    {
        var deadline = DateTime.UtcNow.AddSeconds(waitSec);
        int r;
        do
        {
            r = Send(cdb, outData, inData, timeoutSec);
            if (r == 2 && SenseIsLongWrite()) { Thread.Sleep(1000); continue; }
            return r;
        } while (DateTime.UtcNow < deadline);
        return r;
    }
}

// ---- Encoder CD-Text: pack da 18 byte -> blocchi subcanale da 96 byte ----
static class CdText
{
    // CRC-16 (polinomio 0x1021, tabella identica a cdrdao CdTextEncoder)
    static readonly ushort[] CRCTAB = {
        0x0000,0x1021,0x2042,0x3063,0x4084,0x50A5,0x60C6,0x70E7,0x8108,0x9129,0xA14A,0xB16B,
        0xC18C,0xD1AD,0xE1CE,0xF1EF,0x1231,0x0210,0x3273,0x2252,0x52B5,0x4294,0x72F7,0x62D6,
        0x9339,0x8318,0xB37B,0xA35A,0xD3BD,0xC39C,0xF3FF,0xE3DE,0x2462,0x3443,0x0420,0x1401,
        0x64E6,0x74C7,0x44A4,0x5485,0xA56A,0xB54B,0x8528,0x9509,0xE5EE,0xF5CF,0xC5AC,0xD58D,
        0x3653,0x2672,0x1611,0x0630,0x76D7,0x66F6,0x5695,0x46B4,0xB75B,0xA77A,0x9719,0x8738,
        0xF7DF,0xE7FE,0xD79D,0xC7BC,0x48C4,0x58E5,0x6886,0x78A7,0x0840,0x1861,0x2802,0x3823,
        0xC9CC,0xD9ED,0xE98E,0xF9AF,0x8948,0x9969,0xA90A,0xB92B,0x5AF5,0x4AD4,0x7AB7,0x6A96,
        0x1A71,0x0A50,0x3A33,0x2A12,0xDBFD,0xCBDC,0xFBBF,0xEB9E,0x9B79,0x8B58,0xBB3B,0xAB1A,
        0x6CA6,0x7C87,0x4CE4,0x5CC5,0x2C22,0x3C03,0x0C60,0x1C41,0xEDAE,0xFD8F,0xCDEC,0xDDCD,
        0xAD2A,0xBD0B,0x8D68,0x9D49,0x7E97,0x6EB6,0x5ED5,0x4EF4,0x3E13,0x2E32,0x1E51,0x0E70,
        0xFF9F,0xEFBE,0xDFDD,0xCFFC,0xBF1B,0xAF3A,0x9F59,0x8F78,0x9188,0x81A9,0xB1CA,0xA1EB,
        0xD10C,0xC12D,0xF14E,0xE16F,0x1080,0x00A1,0x30C2,0x20E3,0x5004,0x4025,0x7046,0x6067,
        0x83B9,0x9398,0xA3FB,0xB3DA,0xC33D,0xD31C,0xE37F,0xF35E,0x02B1,0x1290,0x22F3,0x32D2,
        0x4235,0x5214,0x6277,0x7256,0xB5EA,0xA5CB,0x95A8,0x8589,0xF56E,0xE54F,0xD52C,0xC50D,
        0x34E2,0x24C3,0x14A0,0x0481,0x7466,0x6447,0x5424,0x4405,0xA7DB,0xB7FA,0x8799,0x97B8,
        0xE75F,0xF77E,0xC71D,0xD73C,0x26D3,0x36F2,0x0691,0x16B0,0x6657,0x7676,0x4615,0x5634,
        0xD94C,0xC96D,0xF90E,0xE92F,0x99C8,0x89E9,0xB98A,0xA9AB,0x5844,0x4865,0x7806,0x6827,
        0x18C0,0x08E1,0x3882,0x28A3,0xCB7D,0xDB5C,0xEB3F,0xFB1E,0x8BF9,0x9BD8,0xABBB,0xBB9A,
        0x4A75,0x5A54,0x6A37,0x7A16,0x0AF1,0x1AD0,0x2AB3,0x3A92,0xFD2E,0xED0F,0xDD6C,0xCD4D,
        0xBDAA,0xAD8B,0x9DE8,0x8DC9,0x7C26,0x6C07,0x5C64,0x4C45,0x3CA2,0x2C83,0x1CE0,0x0CC1,
        0xEF1F,0xFF3E,0xCF5D,0xDF7C,0xAF9B,0xBFBA,0x8FD9,0x9FF8,0x6E17,0x7E36,0x4E55,0x5E74,
        0x2E93,0x3EB2,0x0ED1,0x1EF0};

    const byte PT_TITLE = 0x80, PT_PERFORMER = 0x81, PT_MESSAGE = 0x85, PT_SIZE = 0x8f;

    // Un pack CD-Text: 18 byte
    class Pack
    {
        public byte[] b = new byte[18];
    }

    static byte[] Latin1(string s, int maxChars)
    {
        if (s == null) s = "";
        s = s.Normalize();
        if (s.Length > maxChars) s = s.Substring(0, maxChars);
        return Encoding.GetEncoding(28591).GetBytes(s);
    }

    // Divide un testo in pack da 12 byte; charPos = offset nel campo.
    static void TextPacks(List<Pack> packs, byte type, int track, string text, int maxChars,
        ref int packId, int[] typeCount)
    {
        byte[] d = Latin1(text, maxChars);
        if (d.Length == 0) return;
        int pos = 0;
        while (pos < d.Length)
        {
            var p = new Pack();
            p.b[0] = type;
            p.b[1] = (byte)track;
            p.b[2] = (byte)packId; packId++;
            // byte3: blocco lingua 0 (bit 4-6), posizione carattere (nibble basso)
            p.b[3] = (byte)(pos > 15 ? 0x0f : pos);
            int n = Math.Min(12, d.Length - pos);
            Array.Copy(d, pos, p.b, 4, n);
            pos += n;
            packs.Add(p);
            typeCount[type - 0x80]++;
        }
    }

    // Costruisce i blocchi subcanale (96 byte ciascuno) per il lead-in.
    // Restituisce null se non c'è niente da scrivere.
    public static byte[][] BuildSubChannels(string album, string albumPerformer,
        string[] titles, string[] performers)
    {
        var packs = new List<Pack>();
        var typeCount = new int[16];
        int packId = 0;

        TextPacks(packs, PT_TITLE, 0, album, 90, ref packId, typeCount);
        TextPacks(packs, PT_PERFORMER, 0, albumPerformer, 90, ref packId, typeCount);
        for (int i = 0; i < titles.Length; i++)
        {
            TextPacks(packs, PT_TITLE, i + 1, titles[i], 90, ref packId, typeCount);
            TextPacks(packs, PT_PERFORMER, i + 1, performers[i], 90, ref packId, typeCount);
        }
        TextPacks(packs, PT_MESSAGE, 0, "MasterHype", 40, ref packId, typeCount);

        if (packs.Count == 0) return null;

        // SIZE_INFO: 36 byte -> 3 pack tipo 0x8f (obbligatorio per molti lettori)
        var sizeInfo = new byte[36];
        sizeInfo[0] = 0x00;                       // ISO-8859-1
        sizeInfo[1] = 1;                          // prima traccia
        sizeInfo[2] = (byte)titles.Length;        // ultima traccia
        sizeInfo[3] = 0;                          // copyright
        for (int i = 0; i < 16; i++) sizeInfo[4 + i] = (byte)typeCount[i];
        sizeInfo[4 + 15] += 3;                    // i 3 pack SIZE_INFO stessi
        sizeInfo[20] = (byte)(packId + 3);        // ultimo sequence number blocco 0
        sizeInfo[28] = 0;                         // language code blocco 0
        for (int i = 0; i < 3; i++)
        {
            var p = new Pack();
            p.b[0] = PT_SIZE;
            p.b[1] = (byte)i;
            p.b[2] = (byte)packId; packId++;
            p.b[3] = 0;
            Array.Copy(sizeInfo, i * 12, p.b, 4, 12);
            packs.Add(p);
        }

        // CRC sui primi 16 byte, invertito, big-endian
        foreach (var p in packs)
        {
            int crc = 0;
            for (int i = 0; i < 16; i++)
                crc = CRCTAB[((crc >> 8) ^ p.b[i]) & 0xff] ^ ((crc << 8) & 0xffff);
            crc = (~crc) & 0xffff;
            p.b[16] = (byte)(crc >> 8);
            p.b[17] = (byte)crc;
        }

        // 4 pack per blocco; ripete dall'inizio per riempire l'ultimo gruppo
        int blockCount = (packs.Count + 3) / 4;
        var blocks = new byte[blockCount][];
        for (int i = 0; i < blockCount; i++)
        {
            var raw = new byte[72];
            for (int j = 0; j < 4; j++)
            {
                var src = packs[(i * 4 + j) % packs.Count].b;
                Array.Copy(src, 0, raw, j * 18, 18);
            }
            // pack -> canali R-W: 3 byte in 4 byte da 6 bit (come PWSubChannel96)
            var blk = new byte[96];
            int k = 0;
            for (int off = 0; off < 96; off += 4)
            {
                blk[off] = (byte)((raw[k] >> 2) & 0x3f);
                blk[off + 1] = (byte)(((raw[k] << 4) & 0x30) | ((raw[k + 1] >> 4) & 0x0f));
                blk[off + 2] = (byte)(((raw[k + 1] << 2) & 0x3c) | ((raw[k + 2] >> 6) & 0x03));
                blk[off + 3] = (byte)(raw[k + 2] & 0x3f);
                k += 3;
            }
            blocks[i] = blk;
        }
        return blocks;
    }
}

class Program
{
    [STAThread] // IMAPI2 è registrato STA: senza STA i cast tipizzati (QI cross-apartment senza proxy) falliscono con E_NOINTERFACE
    static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        try
        {
            if (args.Length == 0) { Json.Err("nessun comando"); return 2; }
            switch (args[0])
            {
                case "list-drives": return ListDrives();
                case "burn-audio": return BurnAudio(Opt(args, "--drive"), FileList(Opt(args, "--files")),
                    Opt(args, "--titles"), Opt(args, "--album"), IntOpt(args, "--speed"));
                case "dao-probe": return DaoProbe(Opt(args, "--drive"));
                case "cdtext-dump": return CdTextDump(Opt(args, "--titles"), Opt(args, "--album"), Opt(args, "--out"));
                case "burn-data": return BurnData(Opt(args, "--drive"), FileList(Opt(args, "--files")), Opt(args, "--label") ?? "MasterHype", IntOpt(args, "--speed"));
                case "erase": return Erase(Opt(args, "--drive"), Has(args, "--full"));
                case "eject": return Eject(Opt(args, "--drive"));
                case "scsi-eject": return ScsiEject(Opt(args, "--drive"), Array.IndexOf(args, "--load") >= 0);
                default: Json.Err("comando sconosciuto: " + args[0]); return 2;
            }
        }
        catch (Exception e)
        {
            Json.Err(e.GetType().Name + ": " + e.Message);
            return 1;
        }
    }

    static string Opt(string[] a, string name)
    {
        for (int i = 0; i < a.Length - 1; i++) if (a[i] == name) return a[i + 1];
        return null;
    }
    static bool Has(string[] a, string name) { return Array.IndexOf(a, name) >= 0; }

    static int IntOpt(string[] a, string name)
    {
        var v = Opt(a, name);
        int n;
        return v != null && int.TryParse(v, out n) ? n : 0;
    }

    // Volume label ISO9660: max 16 char, solo ASCII lettere/cifre/spazio/_/-
    static string VolLabel(string s)
    {
        var sb = new StringBuilder();
        foreach (var c in s.Normalize(NormalizationForm.FormD))
        {
            if (System.Globalization.CharUnicodeInfo.GetUnicodeCategory(c) == System.Globalization.UnicodeCategory.NonSpacingMark) continue;
            if (char.IsLetterOrDigit(c) || c == ' ' || c == '_' || c == '-') sb.Append(c);
        }
        var v = sb.ToString().Trim();
        if (v.Length > 16) v = v.Substring(0, 16).TrimEnd();
        return v.Length > 0 ? v : "MASTERHYPE";
    }

    static void SetSpeed(dynamic rec, int speedX)
    {
        // RequestedWriteSpeed in settori/sec: 1x CD = 75
        if (speedX > 0) { try { rec.RequestedWriteSpeed = speedX * 75; } catch { } }
    }

    static string[] FileList(string path)
    {
        if (path == null || !File.Exists(path)) throw new Exception("lista file mancante: " + path);
        var lines = File.ReadAllLines(path, Encoding.UTF8);
        var list = new List<string>();
        foreach (var l in lines) if (!string.IsNullOrWhiteSpace(l)) list.Add(l.Trim());
        return list.ToArray();
    }

    static object Master()
    {
        return Activator.CreateInstance(Type.GetTypeFromProgID("IMAPI2.MsftDiscMaster2"));
    }

    static object FindRecorder(string driveId)
    {
        dynamic master = Master();
        int count = master.Count;
        for (int i = 0; i < count; i++)
        {
            string id = master.Item(i);
            if (id == driveId)
            {
                dynamic rec = Activator.CreateInstance(Type.GetTypeFromProgID("IMAPI2.MsftDiscRecorder2"));
                rec.InitializeDiscRecorder(id);
                return rec;
            }
        }
        throw new Exception("masterizzatore non trovato: " + driveId);
    }

    // Cast tipizzato con fallback IDispatch: su alcuni sistemi il QI sull'
    // interfaccia fallisce (apartment/proxy) mentre IDispatch funziona sempre.
    static void TAOAddTrack(dynamic fmt, IStream stream)
    {
        try { ((IDiscFormat2TrackAtOnce)fmt).AddAudioTrack(stream); }
        catch (InvalidCastException) { fmt.AddAudioTrack(stream); }
    }
    static void DataWrite(dynamic fmt, IStream stream)
    {
        try { ((IDiscFormat2Data)fmt).Write(stream); }
        catch (InvalidCastException) { fmt.Write(stream); }
    }

    static int ListDrives()
    {
        dynamic master = Master();
        int count = master.Count;
        var sb = new StringBuilder();
        sb.Append("{\"phase\":\"done\",\"drives\":[");
        for (int i = 0; i < count; i++)
        {
            string id = master.Item(i);
            dynamic rec = Activator.CreateInstance(Type.GetTypeFromProgID("IMAPI2.MsftDiscRecorder2"));
            if (i > 0) sb.Append(',');
            try
            {
                rec.InitializeDiscRecorder(id);
                string letter = "";
                try { letter = ((object[])rec.VolumePathNames)[0].ToString(); } catch { }
                string name = ((string)(rec.VendorId + " " + rec.ProductId)).Trim();
                bool present = false, blank = false; string mediaType = "", mediaState = "";
                int free = 0, total = 0;
                try
                {
                    dynamic fmt = Activator.CreateInstance(Type.GetTypeFromProgID("IMAPI2.MsftDiscFormat2Data"));
                    fmt.Recorder = rec;
                    if ((bool)fmt.IsCurrentMediaSupported(rec))
                    {
                        // IMAPI_FORMAT2_DATA_MEDIA_STATE (flag a bit, imapi2.h):
                        //   OVERWRITE_ONLY=1  BLANK=2  APPENDABLE=4  FINAL_SESSION=8
                        //   DAMAGED=0x400  ERASE_REQUIRED=0x800  NON_EMPTY_SESSION=0x1000
                        //   WRITE_PROTECTED=0x2000  FINALIZED=0x4000  UNSUPPORTED=0x8000
                        int status = fmt.CurrentMediaStatus;
                        present = status != 0;               // 0 = UNKNOWN = nessun disco
                        // Scrivibile senza cancellare: vergine oppure media a sovrascrittura (DVD-RAM/BD-RE)
                        blank = (status & 2) != 0 || (status & 1) != 0;
                        // IMAPI_MEDIA_TYPE: enum numerico -> nome leggibile
                        int mt = (int)fmt.CurrentPhysicalMediaType;
                        mediaType = mt == 1 ? "CD-ROM" : mt == 2 ? "CD-R" : mt == 3 ? "CD-RW" :
                            mt == 4 ? "DVD-ROM" : mt == 5 ? "DVD-RAM" : mt == 6 ? "DVD+R" : mt == 7 ? "DVD+RW" :
                            mt == 8 ? "DVD+R DL" : mt == 9 ? "DVD-R" : mt == 10 ? "DVD-RW" : mt == 11 ? "DVD-R DL" :
                            mt == 12 ? "DVD+RW DL" : mt == 14 ? "HD-DVD-ROM" : mt == 15 ? "HD-DVD-R" :
                            mt == 16 ? "HD-DVD-RAM" : mt == 17 ? "BD-ROM" : mt == 18 ? "BD-R" :
                            mt == 19 ? "BD-RE" : "tipo " + mt;
                        if ((status & 0x400) != 0) mediaState = "damaged";
                        else if ((status & 0x8000) != 0) mediaState = "unsupported";
                        else if ((status & 0x2000) != 0) mediaState = "protected";
                        else if ((status & 0x4000) != 0) mediaState = "finalized";
                        else if ((status & 0x800) != 0) mediaState = "erase-required";
                        else if ((status & 0x1000) != 0) mediaState = "non-empty-session";
                        else if ((status & 8) != 0) mediaState = "final-session";
                        else if ((status & 2) != 0) mediaState = "blank";
                        else if ((status & 4) != 0) mediaState = "appendable";
                        try { free = fmt.FreeSectorsOnMedia; total = fmt.TotalSectorsOnMedia; } catch { }
                    }
                }
                catch { /* nessun disco inserito */ }
                sb.Append("{\"id\":\"" + Json.Esc(id) + "\",\"name\":\"" + Json.Esc(name) +
                    "\",\"driveLetter\":\"" + Json.Esc(letter) + "\",\"mediaPresent\":" + (present ? "true" : "false") +
                    ",\"mediaBlank\":" + (blank ? "true" : "false") + ",\"mediaType\":\"" + Json.Esc(mediaType) +
                    "\",\"mediaState\":\"" + mediaState +
                    "\",\"freeSectors\":" + free + ",\"totalSectors\":" + total + "}");
            }
            catch (Exception e)
            {
                sb.Append("{\"id\":\"" + Json.Esc(id) + "\",\"name\":\"(errore: " + Json.Esc(e.Message) + ")\",\"driveLetter\":\"\",\"mediaPresent\":false,\"mediaBlank\":false,\"mediaType\":\"\",\"freeSectors\":0,\"totalSectors\":0}");
            }
        }
        sb.Append("]}");
        Json.Line(sb.ToString());
        return 0;
    }

    // ---- Audio CD (CDA): un WAV PCM 44.1kHz/16bit/stereo per traccia ----
    static int BurnAudio(string driveId, string[] wavFiles, string titlesFile, string album, int speedX)
    {
        if (wavFiles.Length == 0) { Json.Err("nessuna traccia"); return 2; }
        foreach (var f in wavFiles)
            if (!File.Exists(f)) { Json.Err("file mancante: " + f); return 2; }

        // Motore a cascata stile Nero: DAO+CD-Text -> DAO audio-only -> IMAPI TAO.
        // Le capacità del drive sono cache-ate: una strategia rifiutata una volta
        // non si riprova più (niente stati pending inutili sul drive).
        if (titlesFile != null && File.Exists(titlesFile))
        {
            try
            {
                var lines = File.ReadAllLines(titlesFile, Encoding.UTF8);
                if (lines.Length == wavFiles.Length)
                {
                    if (DriveCaps.Get(driveId, "cdtext") != false)
                    {
                        int r = BurnAudioDao(driveId, wavFiles, lines, album ?? "MasterHype", speedX, true);
                        if (r >= 0) return r;
                        DriveCaps.Set(driveId, "cdtext", false);
                        Json.Line("{\"phase\":\"prepare\",\"percent\":3,\"message\":\"Questo drive non supporta CD-Text (" +
                            Json.Esc(DaoWhy ?? "?") + ") — masterizzo senza titoli sul display\"}");
                        RecoverPendingDrive(driveId);
                    }
                    else
                        Json.Line("{\"phase\":\"prepare\",\"percent\":3,\"message\":\"CD-Text non supportato da questo drive — masterizzo senza titoli sul display\"}");
                    if (DriveCaps.Get(driveId, "dao") != false)
                    {
                        // DAO audio-only: stesso motore SCSI ma lead-in generato dal drive
                        // (IMAPI TAO può non funzionare su alcuni drive/OS)
                        int r = BurnAudioDao(driveId, wavFiles, lines, album ?? "MasterHype", speedX, false);
                        if (r >= 0) return r;
                        Json.Line("{\"phase\":\"prepare\",\"percent\":3,\"message\":\"DAO non riuscito: " +
                            Json.Esc(DaoWhy ?? "?") + "\"}");
                        // "drive non pronto" non prova incapacità: non cache-are
                        if (DaoWhy == null || DaoWhy.IndexOf("non pronto") < 0)
                            DriveCaps.Set(driveId, "dao", false);
                        RecoverPendingDrive(driveId);
                    }
                }
            }
            catch (Exception e)
            {
                Json.Line("{\"phase\":\"prepare\",\"percent\":3,\"message\":\"CD-Text non disponibile: " + Json.Esc(e.Message) + "\"}");
            }
        }

        dynamic rec = FindRecorder(driveId);
        SetSpeed(rec, speedX);
        dynamic fmt = Activator.CreateInstance(Type.GetTypeFromProgID("IMAPI2.MsftDiscFormat2TrackAtOnce"));
        fmt.Recorder = rec;
        fmt.ClientName = "MasterHype";
        try { fmt.BufferUnderrunFreeEnabled = true; } catch { }

        long totalBytes = 0;
        foreach (var f in wavFiles) totalBytes += new FileInfo(f).Length;

        // Pre-flight: settori reali dei WAV vs capacità del disco — un CD che
        // non ci sta abortisce PRIMA di PrepareMedia (disco intatto, zero coaster)
        long wavSectors = 0;
        foreach (var f in wavFiles) { long o, l; WavDataRange(f, out o, out l); wavSectors += (l + 2351) / 2352; }
        long need = wavSectors + (wavFiles.Length - 1) * 150L + 11250L; // gap 2s + lead-in/out
        long avail = -1;
        try { avail = (long)fmt.TotalSectorsOnMedia; } catch { /* capacità non leggibile: procede */ }
        if (avail > 0 && need > avail)
        {
            Json.Err(string.Format("troppo lungo: {0:F1} min > disco {1:F1} min",
                need / 4500.0, avail / 4500.0));
            return 2;
        }
        long offset = 0;

        var temps = new List<string>();
        Json.Line("{\"phase\":\"prepare\",\"percent\":2,\"message\":\"Preparazione disco\"}");
        // PrepareMedia fallisce con "unità impegnata" se un DAO precedente ha
        // lasciato il drive in long-write: riprova finché si libera (max 2 min)
        var pmDeadline = DateTime.UtcNow.AddMinutes(2);
        for (;;)
        {
            try { fmt.PrepareMedia(); break; }
            catch (System.Runtime.InteropServices.COMException ce)
            {
                bool busy = ce.Message.IndexOf("impegnata") >= 0 || ce.Message.IndexOf("long") >= 0
                    || unchecked((uint)ce.ErrorCode) == 0xC0AA0514; // IMAPI_E_LONG_WRITE
                if (!busy || DateTime.UtcNow >= pmDeadline) throw;
                Thread.Sleep(3000);
            }
        }
        try
        {
            for (int i = 0; i < wavFiles.Length; i++)
            {
                var name = Path.GetFileNameWithoutExtension(wavFiles[i]);
                Json.Line("{\"phase\":\"write\",\"percent\":" + (int)(2 + offset * 96 / totalBytes) +
                    ",\"trackIndex\":" + (i + 1) + ",\"trackCount\":" + wavFiles.Length +
                    ",\"current\":\"" + Json.Esc(name) + "\"}");
                // stream nativo su WAV canonico: IMAPI2 rifiuta sia IStream managed
                // custom sia file con chunk extra (LIST/INFO) -> "flusso non valido"
                string clean = Wav.EnsureClean(wavFiles[i], temps);
                TAOAddTrack(fmt, Wav.OpenStream(clean));
                offset += new FileInfo(wavFiles[i]).Length;
            }
        }
        finally
        {
            try { fmt.ReleaseMedia(); } catch { }
            foreach (var t in temps) { try { File.Delete(t); } catch { } }
        }
        Json.Line("{\"phase\":\"finalize\",\"percent\":99,\"message\":\"Finalizzazione\"}");
        Json.Line("{\"phase\":\"done\",\"percent\":100}");
        return 0;
    }

    // ---- MP3 / Data CD: MsftFileSystemImage -> ISO -> DiscFormat2Data ----
    // files[0] = cartella temporanea già strutturata (Artista/Album/brano.mp3)
    static int BurnData(string driveId, string[] files, string label, int speedX)
    {
        dynamic rec = FindRecorder(driveId);
        SetSpeed(rec, speedX);
        dynamic fsi = Activator.CreateInstance(Type.GetTypeFromProgID("IMAPI2.MsftFileSystemImage"));
        fsi.ChooseImageDefaults(rec);
        fsi.FileSystemsToCreate = 7; // ISO9660 + Joliet + UDF
        fsi.VolumeName = VolLabel(label);
        Json.Line("{\"phase\":\"prepare\",\"percent\":5,\"message\":\"Costruzione immagine\"}");
        fsi.Root.AddTree(files[0], false);
        dynamic result = fsi.CreateResultImage();
        IStream image = (IStream)result.ImageStream;
        long total = (long)result.TotalBlocks * 2048;

        dynamic fmt = Activator.CreateInstance(Type.GetTypeFromProgID("IMAPI2.MsftDiscFormat2Data"));
        fmt.Recorder = rec;
        fmt.ClientName = "MasterHype";
        try { fmt.BufferUnderrunFreeEnabled = true; } catch { }
        // Pre-flight: l'immagine non deve superare la capacità del disco —
        // meglio un errore pulito che un disco scritto a metà
        long avail = -1;
        try { avail = (long)fmt.TotalSectorsOnMedia; } catch { /* capacità non leggibile: procede */ }
        if (avail > 0 && total > avail * 2048L)
        {
            Json.Err(string.Format("contenuto troppo grande: {0} MB > disco {1} MB",
                total / 1048576, avail * 2048L / 1048576));
            return 2;
        }
        Json.Line("{\"phase\":\"write\",\"percent\":10}");
        DataWrite(fmt, new PassthroughStream(image, Math.Max(1, total)));
        Json.Line("{\"phase\":\"finalize\",\"percent\":98,\"message\":\"Chiusura disco\"}");
        Json.Line("{\"phase\":\"done\",\"percent\":100}");
        return 0;
    }

    static int Erase(string driveId, bool full)
    {
        dynamic rec = FindRecorder(driveId);
        dynamic fmt = Activator.CreateInstance(Type.GetTypeFromProgID("IMAPI2.MsftDiscFormat2Erase"));
        fmt.Recorder = rec;
        fmt.ClientName = "MasterHype";
        fmt.FullErase = full;
        Json.Line("{\"phase\":\"write\",\"percent\":50,\"message\":\"Cancellazione in corso\"}");
        fmt.EraseMedia();
        Json.Line("{\"phase\":\"done\",\"percent\":100}");
        return 0;
    }

    static int Eject(string driveId)
    {
        dynamic rec = FindRecorder(driveId);
        rec.EjectMedia();
        Json.Line("{\"phase\":\"done\"}");
        return 0;
    }

    // Espulsione via SCSI diretto (START STOP UNIT): funziona anche quando
    // IMAPI dice "dispositivo non pronto" (es. drive bloccato in stato pending)
    // Un DAO abortito dopo SEND CUE SHEET lascia il drive occupato a lungo:
    // TEST UNIT READY passa ma le scritture rispondono 02/04/08 "long write
    // in progress". Sonda READ DISC INFO finché non torna quel senso (max 90s).
    // NON fa eject: gli slimline non richiudono il cassetto da software.
    static void RecoverPendingDrive(string driveId)
    {
        try
        {
            string letter = DriveLetter(driveId);
            if (letter == null) return;
            using (var d = ScsiDevice.Open(letter))
            {
                if (d == null) return;
                var di = new byte[34];
                var rdc = new byte[] { 0x51, 0, 0, 0, 0, 0, 0, 0, 34, 0 };
                var deadline = DateTime.UtcNow.AddSeconds(90);
                while (DateTime.UtcNow < deadline)
                {
                    int r = d.Send(rdc, null, di, 20);
                    if (r == 0) return;                     // pronto
                    if (r == 2 && d.SenseIsLongWrite()) { Thread.Sleep(2000); continue; }
                    // altro sense (es. not ready): attendi comunque
                    Thread.Sleep(2000);
                }
            }
        }
        catch { }
    }

    // Post-burn verify: legge la TOC del disco e conta le tracce reali.
    static void VerifyDisc(ScsiDevice d, int expectedTracks)
    {
        try
        {
            var toc = new byte[804];
            if (d.Send(new byte[] { 0x43, 0, 0, 0, 0, 0, 0, (byte)(toc.Length >> 8), (byte)toc.Length, 0 },
                null, toc, 30) != 0) return;
            int lastTrack = toc[3];
            Json.Line("{\"phase\":\"verify\",\"percent\":99,\"message\":\"Verifica disco: " +
                lastTrack + " tracce lette dalla TOC\"}");
            if (lastTrack < expectedTracks)
                Json.Line("{\"phase\":\"prepare\",\"percent\":99,\"message\":\"Attenzione: la TOC riporta " +
                    lastTrack + " tracce su " + expectedTracks + "\"}");
        }
        catch { }
    }

    static int ScsiEject(string driveId, bool load)
    {
        string letter = DriveLetter(driveId);
        if (letter == null) { Json.Err("lettera drive non trovata"); return 1; }
        using (var d = ScsiDevice.Open(letter))
        {
            if (d == null) { Json.Err("apertura " + letter + " fallita"); return 1; }
            // PREVENT/ALLOW prima: un drive in pending può avere il cassetto bloccato
            d.Send(new byte[] { 0x1e, 0, 0, 0, 0, 0 }, null, null, 15);
            var cmd = new byte[] { 0x1b, 0, 0, 0, (byte)(load ? 0x03 : 0x02), 0 };
            int r = d.Send(cmd, null, null, 30);
            if (r != 0)
            {
                Json.Err("start/stop unit fallito (sense " +
                    (d.Sense != null && d.Sense.Length >= 14
                        ? string.Format("{0:X2}/{1:X2}/{2:X2}", d.Sense[2] & 0x0f, d.Sense[12], d.Sense[13])
                        : "n/d") + ", err " + d.LastError + ")"); return 1;
            }
            Json.Line("{\"phase\":\"done\"}");
            return 0;
        }
    }

    // ==================== Audio CD DAO con CD-Text ====================

    static string DriveLetter(string driveId)
    {
        dynamic rec = FindRecorder(driveId);
        try { return ((object[])rec.VolumePathNames)[0].ToString(); } catch { return null; }
    }

    // Diagnostica SPTI senza scrivere nulla: utile per test con/senza disco.
    static int DaoProbe(string driveId)
    {
        string letter;
        try { letter = DriveLetter(driveId); }
        catch (Exception e) { Json.Err("recorder: " + e.Message); return 1; }
        if (letter == null) { Json.Err("lettera drive non trovata"); return 1; }
        using (var d = ScsiDevice.Open(letter))
        {
            if (d == null) { Json.Err("apertura " + letter + " fallita"); return 1; }
            bool ready = d.TestUnitReady();
            string sense = "n/d";
            if (!ready && d.Sense != null && d.Sense.Length >= 14)
                sense = string.Format("{0:X2}/{1:X2}/{2:X2}", d.Sense[2] & 0x0f, d.Sense[12], d.Sense[13]);
            var di = new byte[34];
            bool hasDisc = false; int leadIn = -1; int status = -1;
            if (ready && d.Send(new byte[] { 0x51, 0, 0, 0, 0, 0, 0, 0, 34, 0 }, null, di, 20) == 0)
            {
                hasDisc = true;
                status = di[2] & 0x03;
                leadIn = MsfToLba(di[17], di[18], di[19]);
            }
            Json.Line("{\"phase\":\"done\",\"letter\":\"" + Json.Esc(letter) + "\",\"spti\":true" +
                ",\"ready\":" + (ready ? "true" : "false") + ",\"media\":" + (hasDisc ? "true" : "false") +
                ",\"discStatus\":" + status + ",\"leadInLba\":" + leadIn + ",\"sense\":\"" + sense + "\"}");
        }
        return 0;
    }

    // Scrive i blocchi subcanale CD-Text in un file (solo diagnostica/test)
    static int CdTextDump(string titlesFile, string album, string outPath)
    {
        if (titlesFile == null || outPath == null) { Json.Err("uso: cdtext-dump --titles f.txt --out out.bin"); return 2; }
        var lines = File.ReadAllLines(titlesFile, Encoding.UTF8);
        var titles = new string[lines.Length];
        var artists = new string[lines.Length];
        for (int i = 0; i < lines.Length; i++)
        {
            var parts = (lines[i] ?? "").Split(new char[] { '|' }, 2);
            artists[i] = parts.Length > 1 ? parts[0].Trim() : "";
            titles[i] = parts.Length > 1 ? parts[1].Trim() : parts[0].Trim();
        }
        string perf = artists.Length > 0 ? artists[0] : null;
        for (int i = 1; i < artists.Length; i++)
            if (!string.Equals(artists[i], perf, StringComparison.OrdinalIgnoreCase)) { perf = null; break; }
        var blocks = CdText.BuildSubChannels(album ?? "MasterHype", perf, titles, artists);
        if (blocks == null) { Json.Err("nessun pack generato"); return 1; }
        using (var fs = File.Create(outPath))
            foreach (var b in blocks) fs.Write(b, 0, b.Length);
        Json.Line("{\"phase\":\"done\",\"blocks\":" + blocks.Length + "}");
        return 0;
    }

    static int MsfToLba(int m, int s, int f) { return m * 4500 + s * 75 + f - 150; }
    static void LbaToMsf(int lba, byte[] dst, int off)
    {
        int f = lba + 150;
        dst[off] = (byte)(f / 4500);
        dst[off + 1] = (byte)((f % 4500) / 75);
        dst[off + 2] = (byte)(f % 75);
    }

    // Posizione e lunghezza del chunk "data" in un WAV PCM
    static void WavDataRange(string path, out long offset, out long length)
    {
        using (var fs = File.OpenRead(path))
        using (var br = new BinaryReader(fs))
        {
            if (br.ReadUInt32() != 0x46464952) // "RIFF"
                throw new Exception("non WAV: " + Path.GetFileName(path));
            br.ReadUInt32(); // size RIFF
            if (br.ReadUInt32() != 0x45564157) // "WAVE"
                throw new Exception("non WAV: " + Path.GetFileName(path));
            // formato: fmt chunk deve essere PCM 44.1kHz stereo 16bit
            fs.Position = 12;
            while (fs.Position + 8 <= fs.Length)
            {
                uint id = br.ReadUInt32();
                uint sz = br.ReadUInt32();
                long dataStart = fs.Position;
                if (id == 0x20746d66 && sz >= 16) // "fmt "
                {
                    ushort fmt = br.ReadUInt16(), ch = br.ReadUInt16();
                    uint rate = br.ReadUInt32();
                    br.ReadUInt32(); br.ReadUInt16();
                    ushort bits = br.ReadUInt16();
                    if (fmt != 1 || ch != 2 || rate != 44100 || bits != 16)
                        throw new Exception("WAV non CDA (serve PCM 44.1k/16bit/stereo): " + Path.GetFileName(path));
                }
                else if (id == 0x61746164) // "data"
                {
                    offset = fs.Position;
                    length = Math.Min(sz, fs.Length - fs.Position);
                    return;
                }
                fs.Position = dataStart + sz + (sz & 1);
            }
            throw new Exception("chunk data mancante: " + Path.GetFileName(path));
        }
    }

    public static int ScsiLastFail; // codice Send dell'ultimo fallimento (diagnostica)

    static bool ScsiWrite(ScsiDevice d, int lba, byte[] buf, int blocks)
    {
        var cmd = new byte[10];
        cmd[0] = 0x2a;
        cmd[2] = (byte)(lba >> 24); cmd[3] = (byte)(lba >> 16);
        cmd[4] = (byte)(lba >> 8); cmd[5] = (byte)lba;
        cmd[7] = (byte)(blocks >> 8); cmd[8] = (byte)blocks;
        // ~90s di retry sul "long write in progress": dopo il cue il drive può
        // restare occupato parecchio a preparare la scrittura
        var deadline = DateTime.UtcNow.AddSeconds(90);
        do
        {
            int r = d.Send(cmd, buf, null, 90);
            if (r == 0) { ScsiLastFail = 0; return true; }
            ScsiLastFail = r;
            if (r == 2 && d.SenseIsLongWrite()) { Thread.Sleep(200); continue; }
            return false;
        } while (DateTime.UtcNow < deadline);
        return false;
    }

    // Ritorna: 0 = masterizzato; -1 = setup non supportato (fallback);
    // 1 = errore durante la scrittura (punto di non ritorno superato).
    // cdText=false -> DAO audio-only: il lead-in lo genera il drive (niente
    // subcanali R-W -> funziona sui drive slimline che li rifiutano).
    public static string DaoWhy; // motivo dell'ultimo rifiuto DAO (diagnostica)

    static int DaoFail(string why) { DaoWhy = why; return -1; }

    static string SenseStr(ScsiDevice d)
    {
        if (d.Sense == null || d.Sense.Length == 0) return "n/d";
        var sb = new StringBuilder();
        // formato: key/asc/ascq (fixed 0x70-0x71) o descriptor (0x72-0x73)
        if ((d.Sense[0] & 0x7f) == 0x70 || (d.Sense[0] & 0x7f) == 0x71)
        {
            if (d.Sense.Length >= 14)
                sb.Append(string.Format("{0:X2}/{1:X2}/{2:X2}", d.Sense[2] & 0x0f, d.Sense[12], d.Sense[13]));
        }
        else if (d.Sense.Length >= 4)
            sb.Append(string.Format("d:{0:X2}/{1:X2}/{2:X2}", d.Sense[1] & 0x0f, d.Sense[2], d.Sense[3]));
        sb.Append(" raw:");
        for (int i = 0; i < Math.Min(d.Sense.Length, 18); i++)
            sb.Append(d.Sense[i].ToString("X2"));
        return sb.ToString();
    }

    static int BurnAudioDao(string driveId, string[] wavFiles, string[] titleLines,
        string album, int speedX, bool cdText)
    {
        // titoli: righe "artista|titolo"
        var artists = new string[wavFiles.Length];
        var titles = new string[wavFiles.Length];
        for (int i = 0; i < wavFiles.Length; i++)
        {
            var parts = (titleLines[i] ?? "").Split(new char[] { '|' }, 2);
            artists[i] = parts.Length > 1 ? parts[0].Trim() : "";
            titles[i] = parts.Length > 1 ? parts[1].Trim() : parts[0].Trim();
            if (titles[i].Length == 0) titles[i] = "Traccia " + (i + 1);
        }
        // performer album: solo se tutte le tracce hanno lo stesso artista
        string albumPerf = artists[0];
        for (int i = 1; i < artists.Length; i++)
            if (!string.Equals(artists[i], albumPerf, StringComparison.OrdinalIgnoreCase)) { albumPerf = null; break; }

        // range dati + settori per traccia
        var offs = new long[wavFiles.Length];
        var lens = new long[wavFiles.Length];
        var sectors = new long[wavFiles.Length];
        for (int i = 0; i < wavFiles.Length; i++)
        {
            WavDataRange(wavFiles[i], out offs[i], out lens[i]);
            sectors[i] = (lens[i] + 2351) / 2352;
        }
        long totalSectors = 0;
        foreach (var s in sectors) totalSectors += s;

        var blocks = cdText ? CdText.BuildSubChannels(album, albumPerf, titles, artists) : null;
        if (cdText && blocks == null) return DaoFail("encoder CD-Text fallito");

        string letter;
        try { letter = DriveLetter(driveId); }
        catch { return DaoFail("lettera drive non risolta"); }
        if (letter == null) return DaoFail("lettera drive non trovata");

        using (var d = ScsiDevice.Open(letter))
        {
            if (d == null) return DaoFail("SPTI non apribile su " + letter);

            // --- fase setup: qualsiasi errore qui -> fallback IMAPI2 (disco intatto) ---
            // il drive può restare busy dopo un tentativo precedente: attendi pronto
            var rdy = DateTime.UtcNow.AddSeconds(60);
            while (!d.TestUnitReady())
            {
                if (DateTime.UtcNow >= rdy) return DaoFail("drive non pronto (sense " + SenseStr(d) + ")");
                Thread.Sleep(1000);
            }

            var di = new byte[34];
            if (d.Send(new byte[] { 0x51, 0, 0, 0, 0, 0, 0, 0, 34, 0 }, null, di, 20) != 0)
                return DaoFail("READ DISC INFO fallito (sense " + SenseStr(d) + ")");
            if ((di[2] & 0x03) != 0) return DaoFail("disco non vergine");
            int leadInLba = MsfToLba(di[17], di[18], di[19]);
            // Pre-flight capacità REALE (bytes 17-19 = ultimo lead-out possibile):
            // abortire PRIMA del punto di non ritorno evita un disco rovinato
            if (totalSectors + 150 + 6750 > leadInLba)
            {
                Json.Err(string.Format("troppo lungo: {0:F1} min > disco {1:F1} min",
                    (totalSectors + 6900) / 4500.0, leadInLba / 4500.0));
                return 2;
            }
            int leadInLen = leadInLba >= MsfToLba(80, 0, 0) ? 450000 - leadInLba : MsfToLba(1, 0, 0);

            // MODE SENSE(10) pagina 0x05 -> MODE SELECT: Session-At-Once
            var sense = new byte[8 + 100 + 0x38];
            var mcmd = new byte[] { 0x5a, 0, 0x05, 0, 0, 0, 0, (byte)(sense.Length >> 8), (byte)sense.Length, 0 };
            if (d.Send(mcmd, null, sense, 20) != 0)
                return DaoFail("MODE SENSE p.05 fallito (sense " + SenseStr(d) + ")");
            int blockDescLen = (sense[6] << 8) | sense[7];
            var mp = new byte[0x38];
            int pageLen = Math.Min(0x38, sense[8 + blockDescLen + 1] + 2);
            Array.Copy(sense, 8 + blockDescLen, mp, 0, pageLen);

            for (int variant = 0; variant <= 1; variant++)
            {
                var mpw = (byte[])mp.Clone();
                mpw[0] &= 0x7f;
                mpw[2] &= 0xe0;
                mpw[2] |= 0x02 | 0x40;           // SAO + BURN-Proof
                mpw[3] &= 0x3f;                   // no multisessione
                mpw[4] &= 0xf0;
                if (variant == 0 && cdText) mpw[4] |= 3;    // block 2448 (richiesto per lead-in CD-Text)
                mpw[8] = 0x00;                    // session format CD-DA
                var sel = new byte[8 + pageLen];
                Array.Copy(sense, 0, sel, 0, 8);   // header: preserva medium type
                sel[0] = 0; sel[1] = 0; sel[4] = 0; sel[5] = 0; sel[6] = 0; sel[7] = 0;
                Array.Copy(mpw, 0, sel, 8, pageLen);
                var scmd = new byte[] { 0x55, 0x10, 0, 0, 0, 0, 0, (byte)(sel.Length >> 8), (byte)sel.Length, 0 };
                if (d.SendWait(scmd, sel, null, 20, 120) == 0) break;
                if (variant == 1) return DaoFail("MODE SELECT SAO rifiutato (sense " + SenseStr(d) + ")");
            }

            // power calibration (best effort)
            d.Send(new byte[] { 0x54, 1, 0, 0, 0, 0, 0, 0, 0, 0 }, null, null, 30);

            // cue sheet: lead-in + gap traccia 1 + tracce + lead-out
            int rows = wavFiles.Length + 3;
            var cue = new byte[rows * 8];
            for (int variant = 0; variant <= 1; variant++)
            {
                int n = 0;
                cue[0] = 0x01; cue[1] = 0; cue[2] = 0; cue[3] = (byte)(cdText ? 0x41 : 0x00); cue[4] = 0;
                if (variant == 0) { cue[5] = di[17]; cue[6] = di[18]; cue[7] = di[19]; }
                else { cue[5] = cue[6] = cue[7] = 0; }
                n = 1;
                // gap indice 0 prima traccia a 00:00:00
                cue[8] = 0x01; cue[9] = 1; cue[10] = 0; cue[11] = 0; cue[12] = 0;
                cue[13] = 0; cue[14] = 0; cue[15] = 0;
                n++;
                long pos = 0;
                for (int i = 0; i < wavFiles.Length; i++)
                {
                    int o = n * 8;
                    cue[o] = 0x01; cue[o + 1] = (byte)(i + 1); cue[o + 2] = 1;
                    cue[o + 3] = 0; cue[o + 4] = 0;
                    LbaToMsf((int)pos, cue, o + 5);
                    pos += sectors[i];
                    n++;
                }
                int lo = n * 8;
                cue[lo] = 0x01; cue[lo + 1] = 0xaa; cue[lo + 2] = 1; cue[lo + 3] = 0x01;
                cue[lo + 4] = 0;
                LbaToMsf((int)totalSectors, cue, lo + 5);

                var ccmd = new byte[10];
                ccmd[0] = 0x5d;
                ccmd[6] = (byte)(cue.Length >> 16); ccmd[7] = (byte)(cue.Length >> 8); ccmd[8] = (byte)cue.Length;
                if (d.SendWait(ccmd, cue, null, 20, 120) == 0) break;
                if (variant == 1) return DaoFail("SEND CUE SHEET rifiutato (sense " + SenseStr(d) + ")");
            }

            // ---------- punto di non ritorno: da qui si scrive davvero ----------
            int lba;
            if (cdText)
            {
                Json.Line("{\"phase\":\"write\",\"percent\":2,\"current\":\"Lead-in CD-Text\"}");
                // lead-in: subcanali R-W con i pack CD-Text (96 byte a blocco)
                lba = -150 - leadInLen;
                int chunk = 500;
                var subBuf = new byte[chunk * 96];
                int scp = 0;
                int remain = leadInLen;
                while (remain > 0)
                {
                    int nn = Math.Min(chunk, remain);
                    for (int i = 0; i < nn; i++)
                    {
                        Array.Copy(blocks[scp], 0, subBuf, i * 96, 96);
                        scp = (scp + 1) % blocks.Length;
                    }
                    var w = new byte[nn * 96];
                    Array.Copy(subBuf, w, w.Length);
                    if (!ScsiWrite(d, lba, w, nn))
                    {
                        // Se la PRIMA scrittura fallisce nulla è arrivato sul disco:
                        // il drive non supporta i subcanali raw (tipico degli
                        // slimline) → -1 = fallback, disco ancora vergine.
                        // A scrittura già iniziata invece il disco è compromesso.
                        if (remain == leadInLen) return DaoFail("lead-in R-W rifiutato (sense " + SenseStr(d) + ")");
                        Json.Err("scrittura lead-in CD-Text fallita"); return 1;
                    }
                    lba += nn; remain -= nn;
                    Json.Line("{\"phase\":\"write\",\"percent\":" + (2 + (leadInLen - remain) * 4 / leadInLen) +
                        ",\"current\":\"Lead-in CD-Text\"}");
                }
            }

            // gap iniziale: 150 settori di silenzio (2352 byte a blocco) — è dato
            // host in entrambe le modalità: il cue dichiara index0 a -150 e il
            // drive accetta WRITE solo a partire da quell'indirizzo.
            var zeros = new byte[24 * 2352];
            int gl = -150; int grem = 150;
            while (grem > 0)
            {
                int nn = Math.Min(24, grem);
                var w = new byte[nn * 2352];
                if (!ScsiWrite(d, gl, w, nn))
                {
                    Json.Err("scrittura pre-gap fallita a LBA " + gl + " (send=" + ScsiLastFail +
                        ", sense " + (d.Sense != null && d.Sense.Length >= 14
                            ? string.Format("{0:X2}/{1:X2}/{2:X2}", d.Sense[2] & 0x0f, d.Sense[12], d.Sense[13])
                            : "n/d") + ")"); return 1;
                }
                gl += nn; grem -= nn;
            }

            // audio
            long written = 0;
            lba = 0;
            for (int t = 0; t < wavFiles.Length; t++)
            {
                var name = titles[t];
                Json.Line("{\"phase\":\"write\",\"percent\":" + (int)(6 + written * 90 / Math.Max(1, totalSectors)) +
                    ",\"trackIndex\":" + (t + 1) + ",\"trackCount\":" + wavFiles.Length +
                    ",\"current\":\"" + Json.Esc(name) + "\"}");
                using (var fs = File.OpenRead(wavFiles[t]))
                {
                    fs.Position = offs[t];
                    long left = lens[t];
                    while (left > 0)
                    {
                        int nn = (int)Math.Min(24, (left + 2351) / 2352);
                        var w = new byte[nn * 2352];
                        int rd = fs.Read(w, 0, (int)Math.Min(left, w.Length));
                        left -= rd;
                        if (!ScsiWrite(d, lba, w, nn))
                        {
                            Json.Err("scrittura audio fallita a LBA " + lba + " (send=" + ScsiLastFail +
                                ", err " + d.LastError + ", sense " +
                                (d.Sense != null && d.Sense.Length >= 14
                                    ? string.Format("{0:X2}/{1:X2}/{2:X2}", d.Sense[2] & 0x0f, d.Sense[12], d.Sense[13])
                                    : "n/d") + ")"); return 1;
                        }
                        lba += nn; written += nn;
                        int pct = (int)(6 + written * 90 / Math.Max(1, totalSectors));
                        Json.Line("{\"phase\":\"write\",\"percent\":" + pct + ",\"current\":\"" + Json.Esc(name) + "\"}");
                    }
                }
            }

            // chiusura: sync + attesa lead-out
            Json.Line("{\"phase\":\"finalize\",\"percent\":98,\"message\":\"Chiusura disco (lead-out)\"}");
            d.Send(new byte[] { 0x35, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, null, null, 60);
            var deadline = DateTime.UtcNow.AddMinutes(4);
            while (DateTime.UtcNow < deadline)
            {
                int r = d.Send(new byte[6], null, null, 20);
                if (r == 0) break;
                if (r == 2 && d.SenseIsLongWrite()) { Thread.Sleep(2000); continue; }
                if (r == 2 && d.Sense.Length >= 3 && (d.Sense[2] & 0x0f) == 0x02) { Thread.Sleep(2000); continue; }
                if (r == 1) { Json.Err("drive non risponde dopo la scrittura"); return 1; }
            }
            d.Send(new byte[] { 0x35, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, null, null, 60);
            // post-burn verify: la TOC deve riportare tutte le tracce
            VerifyDisc(d, wavFiles.Length);
        }
        Json.Line("{\"phase\":\"done\",\"percent\":100}");
        return 0;
    }
}
