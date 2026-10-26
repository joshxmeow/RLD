import ipaddress
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


def ensure_certificates(cert_dir, address):
    cert_dir = Path(cert_dir)
    cert_dir.mkdir(parents=True, exist_ok=True)
    ca_key_path = cert_dir / "local-ca-key.pem"
    ca_cert_path = cert_dir / "local-ca.crt"
    server_key_path = cert_dir / "server-key.pem"
    server_cert_path = cert_dir / "server.crt"
    ip_address = ipaddress.ip_address(address)

    if not ca_key_path.exists() or not ca_cert_path.exists():
        ca_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        ca_subject = x509.Name([
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "RLD Local App"),
            x509.NameAttribute(NameOID.COMMON_NAME, "RLD Private Local Certificate Authority"),
        ])
        now = datetime.now(timezone.utc)
        ca_cert = (
            x509.CertificateBuilder()
            .subject_name(ca_subject)
            .issuer_name(ca_subject)
            .public_key(ca_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=5))
            .not_valid_after(now + timedelta(days=3650))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.KeyUsage(
                digital_signature=True, content_commitment=False, key_encipherment=False,
                data_encipherment=False, key_agreement=False, key_cert_sign=True,
                crl_sign=True, encipher_only=False, decipher_only=False,
            ), critical=True)
            .sign(ca_key, hashes.SHA256())
        )
        ca_key_path.write_bytes(ca_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ))
        ca_cert_path.write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))
    else:
        ca_key = serialization.load_pem_private_key(ca_key_path.read_bytes(), password=None)
        ca_cert = x509.load_pem_x509_certificate(ca_cert_path.read_bytes())

    needs_server_cert = not server_cert_path.exists() or not server_key_path.exists()
    if not needs_server_cert:
        current_cert = x509.load_pem_x509_certificate(server_cert_path.read_bytes())
        try:
            sans = current_cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
            needs_server_cert = ip_address not in sans.get_values_for_type(x509.IPAddress)
        except x509.ExtensionNotFound:
            needs_server_cert = True

    if needs_server_cert:
        server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        now = datetime.now(timezone.utc)
        server_subject = x509.Name([
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "RLD Local App"),
            x509.NameAttribute(NameOID.COMMON_NAME, str(ip_address)),
        ])
        server_cert = (
            x509.CertificateBuilder()
            .subject_name(server_subject)
            .issuer_name(ca_cert.subject)
            .public_key(server_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=5))
            .not_valid_after(now + timedelta(days=730))
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ip_address)]), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .sign(ca_key, hashes.SHA256())
        )
        server_key_path.write_bytes(server_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ))
        server_cert_path.write_bytes(server_cert.public_bytes(serialization.Encoding.PEM))

    return server_cert_path, server_key_path, ca_cert_path
