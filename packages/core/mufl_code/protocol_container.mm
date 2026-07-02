// Minimal protocol_container library — provides ::protocol_container::init_my_ipd,
// which the ADAPT wrapper runs on every packet during broker registration
// (possession-proof / identity-proof-document setup, adapt #77). Mirrors the
// toolkit's per-unit protocol_container stub; deps resolve from the stdlib.
library protocol_container loads libraries
    identity_proof_document,
    identity_proof_document_types,
    native_attestation_document,
    browser_attestation_document,
    current_transaction_info
    uses transactions
{
    trn init_my_ipd _ {
        current_transaction_info::validate_origin (::transaction::envelope::origin::user,).
        identity_proof_document_types::set_my_ipd(identity_proof_document::create()).
        return ::transaction::success [].
    }
}
