# XSDs Hacienda CR v4.4

Schemas oficiales de los 6 tipos de comprobantes electrónicos de Hacienda
Costa Rica, versión 4.4 (obligatoria desde 1-sep-2025).

## Origen

Descargados desde `https://www.hacienda.go.cr/docs/` (URL base oficial).

Todos los XSDs referencian `../../xmldsig-core-schema.xsd` (XML Digital
Signatures de W3C), que vive en `apps/facturas/xmldsig-core-schema.xsd`.
Sin ese archivo, `lxml.etree.XMLSchema()` falla al resolver el import.

## Tipos cubiertos

| Tipo | Root element | Filename | Namespace |
|---|---|---|---|
| FE | FacturaElectronica | FacturaElectronica.xsd | `https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/facturaElectronica` |
| TE | TiqueteElectronico | TiqueteElectronico.xsd | `https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/tiqueteElectronico` |
| NC | NotaCreditoElectronica | NotaCreditoElectronica.xsd | `https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/notaCreditoElectronica` |
| ND | NotaDebitoElectronica | NotaDebitoElectronica.xsd | `https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/notaDebitoElectronica` |
| FEC | FacturaElectronicaCompra | FacturaElectronicaCompra.xsd | `https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/facturaElectronicaCompra` |
| FEE | FacturaElectronicaExportacion | FacturaElectronicaExportacion.xsd | `https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/facturaElectronicaExportacion` |

## Uso

`apps.facturas.parsers.xml_parser.parse_comprobante_xml(file_path)` detecta
el tipo por el namespace del root y carga el XSD correspondiente para
validación antes de extraer datos.

## Actualizar a nuevas versiones

Cuando Hacienda publique una nueva versión (v4.5, v5.0):
1. Crear carpeta `V4.5/` (o equivalente)
2. Descargar XSDs nuevos desde `https://www.hacienda.go.cr/docs/`
3. Actualizar `NAMESPACE_MAP` en `xml_parser.py` con los nuevos namespaces
4. Mantener carpetas viejas para procesar comprobantes históricos
